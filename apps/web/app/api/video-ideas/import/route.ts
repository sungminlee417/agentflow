import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  decrypt,
  extractPostedVideoId,
  fetchImportedVideoMetadata,
  getFreshAccessToken,
  runPostReview,
  savePostReview,
} from "@agentflow/core";

// Import an existing video the user has already posted on TT / YT /
// IG and run the same review pipeline that generated ideas go through.
//
// The synthetic shape:
//   • One video_ideas row, status='done', kind=<user pick or 'pattern'>,
//     title from platform metadata, no script/hook/rationale.
//   • One video_idea_posts row linked to it, posted_video_id from URL,
//     posted_at from platform.
//   • runPostReview fires synchronously so the import lands with the
//     verdict already attached. Worker still schedules the next pass.
//
// This feeds the agent's recentReviews loop on the next refresh, so
// importing your back catalogue makes future generations smarter.

export const maxDuration = 60;

const ALLOWED_KINDS = new Set([
  "pattern",
  "trend",
  "rising",
  "competitor",
  "seasonal",
]);

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    integration_id?: string;
    url?: string;
    kind?: string;
    title_override?: string;
    format?: string;
  } | null;
  if (!body?.integration_id || !body?.url) {
    return NextResponse.json(
      { error: "integration_id and url are required" },
      { status: 400 },
    );
  }
  const kind =
    body.kind && ALLOWED_KINDS.has(body.kind) ? body.kind : "pattern";

  const { data: integration } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("user_id", user.id)
    .eq("id", body.integration_id)
    .maybeSingle();
  if (!integration) {
    return NextResponse.json(
      { error: "Integration not found." },
      { status: 404 },
    );
  }

  const platform = integration.provider as string;
  const videoId = extractPostedVideoId(platform, body.url);
  if (!videoId) {
    return NextResponse.json(
      {
        error: `Couldn't parse a ${platform} video id out of that URL. Paste the full video link.`,
      },
      { status: 400 },
    );
  }

  let token: string;
  try {
    token = await getFreshAccessToken(
      supabase,
      user.id,
      platform as "tiktok" | "youtube" | "instagram",
      {
        id: integration.id as string,
        encrypted_access_token: integration.encrypted_access_token as string,
        encrypted_refresh_token:
          (integration.encrypted_refresh_token as string | null) ?? null,
        expires_at: (integration.expires_at as string | null) ?? null,
      },
    );
  } catch {
    token = decrypt(integration.encrypted_access_token as string);
  }

  // Pull title + posted_at from the platform itself. Confirms the
  // video actually belongs to this integration (the API returns
  // nothing if the token doesn't own the video).
  const meta = await fetchImportedVideoMetadata(platform, token, body.url);
  if (!meta) {
    return NextResponse.json(
      {
        error: `${platform} returned no metadata for that video. Make sure it belongs to the connected account.`,
      },
      { status: 404 },
    );
  }

  const title = (body.title_override ?? meta.title ?? "Imported video").slice(
    0,
    200,
  );

  // 1. Synthetic idea row. status='done' so it lands in the Posted tab.
  //    Script/hook/rationale stay null — this video already exists; the
  //    point is to learn from it, not regenerate it.
  const { data: ideaRow, error: ideaErr } = await supabase
    .from("video_ideas")
    .insert({
      user_id: user.id,
      integration_id: integration.id,
      provider: platform,
      title,
      hook: null,
      format: body.format ?? null,
      rationale: "Imported from an existing posted video.",
      kind,
      source_refs: { imported: true, url: body.url },
      // Already-posted videos don't need an expiry — set far enough out
      // that the page-load pruner never deletes them.
      expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      status: "done",
      posted_video_id: videoId,
      posted_video_url: meta.url ?? body.url,
      posted_at: meta.postedAt,
    })
    .select("id")
    .single();
  if (ideaErr || !ideaRow) {
    return NextResponse.json(
      { error: `Could not save idea: ${ideaErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // 1b. Mirror the integration into video_idea_targets so the page
  // loader's join finds this imported idea under the right account.
  await supabase.from("video_idea_targets").insert({
    idea_id: ideaRow.id,
    integration_id: integration.id,
    user_id: user.id,
    is_primary: true,
  });

  // 2. Per-platform post row — the review pipeline reads from this.
  const { data: postRow, error: postErr } = await supabase
    .from("video_idea_posts")
    .insert({
      idea_id: ideaRow.id,
      user_id: user.id,
      integration_id: integration.id,
      platform,
      posted_video_id: videoId,
      posted_video_url: meta.url ?? body.url,
      posted_at: meta.postedAt,
    })
    .select("id")
    .single();
  if (postErr || !postRow) {
    // Roll back the idea row to keep things tidy.
    await supabase
      .from("video_ideas")
      .delete()
      .eq("id", ideaRow.id)
      .eq("user_id", user.id);
    return NextResponse.json(
      { error: `Could not save post: ${postErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // 3. Synchronous review. The video already exists, so the verdict
  //    can land immediately. The worker still schedules the +48h / +7d
  //    follow-ups because savePostReview writes next_review_at.
  const result = await runPostReview({
    supabase,
    userId: user.id,
    postId: postRow.id as string,
  });
  if (result.ok) {
    await savePostReview(supabase, user.id, postRow.id as string, result);
  }

  return NextResponse.json({
    ok: true,
    idea_id: ideaRow.id,
    post_id: postRow.id,
    title,
    verdict: result.verdict ?? null,
    ratio: result.stats?.ratio ?? null,
    review_error: result.ok ? null : result.error,
  });
}
