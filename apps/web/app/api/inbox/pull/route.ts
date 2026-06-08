import { NextResponse, type NextRequest } from "next/server";
import { generateText } from "ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  decrypt,
  getFreshAccessToken,
  getModel,
  isProvider,
} from "@agentflow/core";

// POST /api/inbox/pull
//
// Body: { integration_ids?: string[] }
//
// For each requested account (default = all connected social
// integrations), pull the most recent comments on the creator's
// recent posts, dedupe against the existing comment_replies table,
// and generate a per-comment AI reply draft using the per-account
// voice anchor.
//
// Returns { pulled: number, by_account: { [integrationId]: number } }.

export const maxDuration = 60;

const RECENT_MEDIA_LIMIT = 8;
const COMMENTS_PER_MEDIA = 15;

type IntegrationRow = {
  id: string;
  provider: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  expires_at: string | null;
  handle: string | null;
  display_name: string | null;
  account_label: string | null;
};

type IncomingComment = {
  source_comment_id: string;
  source_author: string | null;
  source_text: string;
  source_video_id: string;
  source_video_url: string | null;
  source_video_title: string | null;
  source_posted_at: string | null;
};

function labelFor(i: IntegrationRow): string {
  return (
    i.account_label?.trim() ||
    i.display_name?.trim() ||
    i.handle?.trim() ||
    `${i.provider} account`
  );
}

// ─────────────────────────────────────────────────────────────────────
// Instagram fetcher
// ─────────────────────────────────────────────────────────────────────

async function igFetch(
  path: string,
  token: string,
  query?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`https://graph.instagram.com${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Instagram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function fetchInstagramComments(token: string): Promise<IncomingComment[]> {
  const media = (await igFetch("/me/media", token, {
    fields: "id,permalink,caption,timestamp",
    limit: String(RECENT_MEDIA_LIMIT),
  })) as { data?: Array<{ id: string; permalink?: string; caption?: string; timestamp?: string }> };

  const out: IncomingComment[] = [];
  for (const m of media.data ?? []) {
    try {
      const comments = (await igFetch(`/${m.id}/comments`, token, {
        fields: "id,text,username,timestamp",
        limit: String(COMMENTS_PER_MEDIA),
      })) as {
        data?: Array<{
          id: string;
          text?: string;
          username?: string;
          timestamp?: string;
        }>;
      };
      for (const c of comments.data ?? []) {
        if (!c.text) continue;
        out.push({
          source_comment_id: c.id,
          source_author: c.username ?? null,
          source_text: c.text,
          source_video_id: m.id,
          source_video_url: m.permalink ?? null,
          source_video_title: m.caption?.slice(0, 200) ?? null,
          source_posted_at: c.timestamp ?? null,
        });
      }
    } catch (err) {
      console.error("[inbox/pull] IG comments failed for media", m.id, err);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// YouTube fetcher (uses Data API v3)
// ─────────────────────────────────────────────────────────────────────

async function ytFetch(token: string, path: string): Promise<unknown> {
  const url = path.startsWith("http")
    ? path
    : `https://www.googleapis.com/youtube/v3${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`YouTube ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function fetchYouTubeComments(token: string): Promise<IncomingComment[]> {
  // Find the uploads playlist id, then list recent videos.
  const channels = (await ytFetch(
    token,
    "/channels?part=contentDetails&mine=true",
  )) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
  const uploadsId = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return [];

  const playlist = (await ytFetch(
    token,
    `/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=${RECENT_MEDIA_LIMIT}`,
  )) as {
    items?: Array<{
      snippet?: {
        resourceId?: { videoId?: string };
        title?: string;
      };
    }>;
  };
  const videos = (playlist.items ?? [])
    .map((it) => ({
      id: it.snippet?.resourceId?.videoId ?? null,
      title: it.snippet?.title ?? null,
    }))
    .filter((v): v is { id: string; title: string | null } => !!v.id);

  const out: IncomingComment[] = [];
  for (const v of videos) {
    try {
      const data = (await ytFetch(
        token,
        `/commentThreads?part=snippet&videoId=${v.id}&maxResults=${COMMENTS_PER_MEDIA}&order=time`,
      )) as {
        items?: Array<{
          id: string;
          snippet?: {
            topLevelComment?: {
              id?: string;
              snippet?: {
                authorDisplayName?: string;
                textDisplay?: string;
                publishedAt?: string;
              };
            };
          };
        }>;
      };
      for (const thread of data.items ?? []) {
        const c = thread.snippet?.topLevelComment;
        const cid = c?.id;
        const text = c?.snippet?.textDisplay;
        if (!cid || !text) continue;
        out.push({
          source_comment_id: cid,
          source_author: c?.snippet?.authorDisplayName ?? null,
          source_text: text,
          source_video_id: v.id,
          source_video_url: `https://www.youtube.com/watch?v=${v.id}`,
          source_video_title: v.title,
          source_posted_at: c?.snippet?.publishedAt ?? null,
        });
      }
    } catch (err) {
      console.error("[inbox/pull] YT comments failed for video", v.id, err);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// AI draft generation
// ─────────────────────────────────────────────────────────────────────

function draftSystemPrompt(args: {
  accountLabel: string;
  platform: string;
  voiceAnchor: string;
}): string {
  const { accountLabel, platform, voiceAnchor } = args;
  return `You are a copy editor helping a content creator draft a reply to a comment on one of their ${platform} posts.

ACCOUNT: ${accountLabel} (${platform})

VOICE ANCHOR — what's worked recently for this creator:
${voiceAnchor || "(no review history yet — keep it natural and on-brand)"}

DRAFT RULES:
- Match the creator's voice from the voice anchor — same vibe, same energy level.
- Concise: 1-2 short sentences, plus an emoji ONLY if natural for the platform.
- Specific. Engage with what the commenter actually said, don't just say "thanks".
- If the comment is a genuine question, answer it directly.
- If the comment is praise, accept it briefly and either redirect to a related piece of content OR ask a follow-up question to drive more engagement.
- If the comment is negative/troll/spam, draft a one-line graceful acknowledgement — the user will likely just dismiss it but having a draft to read is faster than typing one.

OUTPUT FORMAT — STRICT: Your final response is ONLY the reply text. No prose preamble, no quoted comment, no markdown — just the reply ready to paste.`;
}

async function generateDraftsForComments(
  supabase: ReturnType<typeof createSupabaseServerClient> extends Promise<infer T> ? T : never,
  userId: string,
  integration: IntegrationRow,
  comments: IncomingComment[],
): Promise<Map<string, string | null>> {
  if (comments.length === 0) return new Map();

  // Pull AI key once.
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, encrypted_key, model")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (!keys || keys.length === 0) return new Map(); // no key → no drafts; route still inserts the raw comments

  const { provider: aiProvider, encrypted_key, model: userModel } = keys[0]!;
  if (!isProvider(aiProvider)) return new Map();
  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch {
    return new Map();
  }

  // Voice anchor: top 3 reviewed posts for this account, with verdict.
  let voiceAnchor = "";
  try {
    const { data } = await supabase
      .from("video_idea_posts")
      .select(
        "performance_verdict, performance_stats, video_ideas!inner(title, format)",
      )
      .eq("user_id", userId)
      .eq("integration_id", integration.id)
      .not("performance_verdict", "is", null)
      .neq("performance_verdict", "too_early")
      .order("last_reviewed_at", { ascending: false })
      .limit(3);
    type Row = {
      performance_verdict: string | null;
      performance_stats: { ratio?: number } | null;
      video_ideas:
        | { title?: string; format?: string | null }
        | Array<{ title?: string; format?: string | null }>
        | null;
    };
    const lines: string[] = [];
    for (const r of (data ?? []) as unknown as Row[]) {
      const idea = Array.isArray(r.video_ideas) ? r.video_ideas[0] : r.video_ideas;
      if (!idea?.title) continue;
      const ratio = r.performance_stats?.ratio;
      lines.push(
        `- "${idea.title}" (${idea.format ?? "?"}) → ${r.performance_verdict}${ratio != null ? ` · ${ratio.toFixed(2)}× median` : ""}`,
      );
    }
    voiceAnchor = lines.join("\n");
  } catch {
    // empty voice anchor is OK
  }

  const accountLabel = labelFor(integration);
  const system = draftSystemPrompt({
    accountLabel,
    platform: integration.provider,
    voiceAnchor,
  });

  // Bounded concurrency: 3 in flight at a time. Keeps us under
  // per-minute token caps without serialising end-to-end.
  const out = new Map<string, string | null>();
  const queue = [...comments];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < 3; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const c = queue.shift();
          if (!c) return;
          try {
            const result = await generateText({
              model: getModel(aiProvider, apiKey, userModel),
              system,
              messages: [
                {
                  role: "user",
                  content: `Comment to reply to:\n@${c.source_author ?? "viewer"}: ${c.source_text}\n\nVideo: "${c.source_video_title ?? "(untitled)"}"\n\nDraft a reply now.`,
                },
              ],
            });
            out.set(c.source_comment_id, result.text.trim());
          } catch (err) {
            console.error(
              "[inbox/pull] draft generation failed for comment",
              c.source_comment_id,
              err,
            );
            out.set(c.source_comment_id, null);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────

const SUPPORTED_PROVIDERS = new Set(["instagram", "youtube"]);
// TikTok comment reply requires app-review scopes (comment.create) we
// don't have yet. The pull route silently skips TT accounts; once the
// scope is granted, add "tiktok" here + a fetchTikTokComments helper.

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    integration_ids?: string[];
  } | null;

  const { data: allIntegrations } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at, handle, display_name, account_label",
    )
    .eq("user_id", user.id);

  const supportable = (allIntegrations ?? []).filter(
    (i): i is IntegrationRow =>
      SUPPORTED_PROVIDERS.has(i.provider as string) &&
      !!(i as IntegrationRow).encrypted_access_token,
  );

  let toPull: IntegrationRow[];
  if (body?.integration_ids && body.integration_ids.length > 0) {
    const requested = new Set(body.integration_ids);
    toPull = supportable.filter((i) => requested.has(i.id));
  } else {
    toPull = supportable;
  }
  if (toPull.length === 0) {
    return NextResponse.json({ pulled: 0, by_account: {} });
  }

  const byAccount: Record<string, number> = {};
  let totalPulled = 0;

  for (const integration of toPull) {
    try {
      const token = await getFreshAccessToken(
        supabase,
        user.id,
        integration.provider as "youtube" | "instagram",
        {
          id: integration.id,
          encrypted_access_token: integration.encrypted_access_token,
          encrypted_refresh_token: integration.encrypted_refresh_token,
          expires_at: integration.expires_at,
        },
      );

      let comments: IncomingComment[] = [];
      if (integration.provider === "instagram") {
        comments = await fetchInstagramComments(token);
      } else if (integration.provider === "youtube") {
        comments = await fetchYouTubeComments(token);
      }

      // Dedupe against existing rows.
      if (comments.length > 0) {
        const ids = comments.map((c) => c.source_comment_id);
        const { data: existing } = await supabase
          .from("comment_replies")
          .select("source_comment_id")
          .eq("integration_id", integration.id)
          .in("source_comment_id", ids);
        const seen = new Set(
          (existing ?? []).map((r) => r.source_comment_id as string),
        );
        comments = comments.filter(
          (c) => !seen.has(c.source_comment_id),
        );
      }

      if (comments.length === 0) {
        byAccount[integration.id] = 0;
        continue;
      }

      const drafts = await generateDraftsForComments(
        supabase,
        user.id,
        integration,
        comments,
      );

      const rows = comments.map((c) => ({
        user_id: user.id,
        integration_id: integration.id,
        platform: integration.provider,
        source_comment_id: c.source_comment_id,
        source_author: c.source_author,
        source_text: c.source_text.slice(0, 2000),
        source_video_id: c.source_video_id,
        source_video_url: c.source_video_url,
        source_video_title: c.source_video_title,
        source_posted_at: c.source_posted_at,
        draft_text: drafts.get(c.source_comment_id) ?? null,
        draft_model: null,
        status: "draft",
      }));

      const { error: insertErr } = await supabase
        .from("comment_replies")
        .insert(rows);
      if (insertErr) {
        console.error(
          "[inbox/pull] insert failed for",
          integration.id,
          insertErr.message,
        );
      } else {
        byAccount[integration.id] = rows.length;
        totalPulled += rows.length;
      }

      // Update last_pulled_at.
      await supabase.from("inbox_pull_state").upsert(
        {
          user_id: user.id,
          integration_id: integration.id,
          last_pulled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "integration_id" },
      );
    } catch (err) {
      console.error(
        "[inbox/pull] integration",
        integration.id,
        "failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({ pulled: totalPulled, by_account: byAccount });
}
