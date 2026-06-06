import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  decrypt,
  extractPostedVideoId,
  fetchImportedVideoMetadata,
  getFreshAccessToken,
} from "@agentflow/core";

// Link an idea to one OR more posted videos (per-platform) and mark
// the idea as 'done'. Each post gets its own video_idea_posts row
// with its own +48h review schedule.
//
// Request shape:
//   { posts: [{ integration_id, url }, ...] }
//
// Legacy shape (single TikTok post) is preserved for the old client:
//   { posted_video_url? | posted_video_id? }
//   → treated as a single post on the idea's source integration.
//
// { unlink_post_id } removes a single per-platform post row.
// { unlink: true } removes ALL posts for the idea and rewinds status
// to 'pending'.

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    posts?: Array<{ integration_id: string; url: string }>;
    posted_video_url?: string;
    posted_video_id?: string;
    unlink?: boolean;
    unlink_post_id?: string;
  } | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  // Verify ownership of the idea + grab integration_id for legacy path.
  const { data: idea } = await supabase
    .from("video_ideas")
    .select("id, integration_id, provider")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (!idea) return new NextResponse("Idea not found", { status: 404 });

  // ── Unlink a single post ─────────────────────────────────────────
  if (body.unlink_post_id) {
    await supabase
      .from("video_idea_posts")
      .delete()
      .eq("idea_id", id)
      .eq("user_id", user.id)
      .eq("id", body.unlink_post_id);

    // If that was the LAST post, rewind the idea to pending.
    const { count } = await supabase
      .from("video_idea_posts")
      .select("id", { count: "exact", head: true })
      .eq("idea_id", id);
    if ((count ?? 0) === 0) {
      await supabase
        .from("video_ideas")
        .update({
          status: "pending",
          posted_video_id: null,
          posted_video_url: null,
          posted_at: null,
          performance_verdict: null,
          performance_score: null,
          performance_review: null,
          performance_stats: null,
          last_reviewed_at: null,
          next_review_at: null,
        })
        .eq("id", id);
    }
    return new NextResponse(null, { status: 204 });
  }

  // ── Unlink ALL posts ─────────────────────────────────────────────
  if (body.unlink) {
    await supabase
      .from("video_idea_posts")
      .delete()
      .eq("idea_id", id)
      .eq("user_id", user.id);
    await supabase
      .from("video_ideas")
      .update({
        status: "pending",
        posted_video_id: null,
        posted_video_url: null,
        posted_at: null,
        performance_verdict: null,
        performance_score: null,
        performance_review: null,
        performance_stats: null,
        last_reviewed_at: null,
        next_review_at: null,
      })
      .eq("user_id", user.id)
      .eq("id", id);
    return new NextResponse(null, { status: 204 });
  }

  // Normalize the inbound posts array. Accept both the new shape and
  // the legacy single-post shape.
  type Pending = { integration_id: string; url: string };
  const pending: Pending[] =
    body.posts && body.posts.length > 0
      ? body.posts
      : body.posted_video_url || body.posted_video_id
        ? [
            {
              integration_id: idea.integration_id as string,
              url:
                body.posted_video_url ??
                `https://www.tiktok.com/video/${body.posted_video_id}`,
            },
          ]
        : [];

  if (pending.length === 0) {
    return NextResponse.json(
      { error: "Pass at least one post to link." },
      { status: 400 },
    );
  }

  // Resolve each pending post: validate integration ownership + parse
  // the platform-appropriate provider id from the URL.
  const integrationIds = Array.from(new Set(pending.map((p) => p.integration_id)));
  const { data: integrations } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("user_id", user.id)
    .in("id", integrationIds);
  const integrationByPid = new Map(
    (integrations ?? []).map((i) => [i.id as string, i]),
  );

  // Bring posted_at + next_review_at off the wall clock and onto the
  // platform's actual publish time. The review math (hours_since_posted,
  // verdict thresholds, +48h / +7d scheduling) all keys off this; using
  // mark-done time skews every review against the wrong reference.
  const nowMs = Date.now();
  const inserts: Array<{
    idea_id: string;
    user_id: string;
    integration_id: string;
    platform: string;
    posted_video_id: string;
    posted_video_url: string;
    posted_at: string;
    next_review_at: string;
  }> = [];
  const errors: string[] = [];
  for (const p of pending) {
    const integration = integrationByPid.get(p.integration_id);
    if (!integration) {
      errors.push(`Unknown integration ${p.integration_id}.`);
      continue;
    }
    const platform = integration.provider as string;
    const videoId = extractPostedVideoId(platform, p.url);
    if (!videoId) {
      errors.push(`Could not parse a ${platform} video id from: ${p.url}`);
      continue;
    }

    // Pull the platform's own posted_at. Best-effort — token errors
    // or videos the API can't see (privacy, just-uploaded propagation
    // lag) fall back to NOW so the user can still mark the idea done.
    let actualPostedAt: Date | null = null;
    try {
      const accessToken = integration.encrypted_access_token as string | null;
      if (accessToken) {
        const token = await getFreshAccessToken(
          supabase,
          user.id,
          platform as "tiktok" | "youtube" | "instagram",
          {
            id: integration.id as string,
            encrypted_access_token: accessToken,
            encrypted_refresh_token:
              (integration.encrypted_refresh_token as string | null) ?? null,
            expires_at: (integration.expires_at as string | null) ?? null,
          },
        ).catch(() => decrypt(accessToken));
        const meta = await fetchImportedVideoMetadata(platform, token, p.url);
        if (meta?.postedAt) actualPostedAt = new Date(meta.postedAt);
      }
    } catch (err) {
      console.warn(
        `[video-ideas/link] couldn't resolve real posted_at for ${platform} ${videoId}:`,
        err,
      );
    }

    const postedAt = actualPostedAt ?? new Date(nowMs);
    // If the video is >48h old already, schedule the next review for
    // 1 minute from now so the worker picks it up immediately rather
    // than queuing a review for a moment in the past.
    const fortyEightHoursOut = postedAt.getTime() + 48 * 60 * 60 * 1000;
    const nextReview = new Date(
      Math.max(fortyEightHoursOut, nowMs + 60 * 1000),
    );

    inserts.push({
      idea_id: id,
      user_id: user.id,
      integration_id: p.integration_id,
      platform,
      posted_video_id: videoId,
      posted_video_url: p.url,
      posted_at: postedAt.toISOString(),
      next_review_at: nextReview.toISOString(),
    });
  }

  if (inserts.length === 0) {
    return NextResponse.json(
      { error: errors.join(" / ") || "No valid posts to link." },
      { status: 400 },
    );
  }

  // Upsert. UNIQUE (idea_id, platform, posted_video_id) means re-link
  // of the same post is a no-op (caller can use this to refresh URL).
  const { error: postErr } = await supabase
    .from("video_idea_posts")
    .upsert(inserts, { onConflict: "idea_id,platform,posted_video_id" });
  if (postErr) {
    return NextResponse.json(
      { error: `Post insert failed: ${postErr.message}` },
      { status: 500 },
    );
  }

  // Mirror the FIRST post into video_ideas.posted_* as the
  // backward-compat cache + flip status.
  const primary = inserts[0]!;
  await supabase
    .from("video_ideas")
    .update({
      status: "done",
      posted_video_id: primary.posted_video_id,
      posted_video_url: primary.posted_video_url,
      posted_at: primary.posted_at,
      next_review_at: primary.next_review_at,
      // Clear any prior aggregate review so stale data doesn't show.
      performance_verdict: null,
      performance_score: null,
      performance_review: null,
      performance_stats: null,
      last_reviewed_at: null,
    })
    .eq("user_id", user.id)
    .eq("id", id);

  return NextResponse.json({
    ok: true,
    linked: inserts.length,
    errors: errors.length > 0 ? errors : undefined,
    next_review_at: primary.next_review_at,
  });
}
