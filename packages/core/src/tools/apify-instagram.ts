import { tool } from "ai";
import { z } from "zod";

// Apify-backed Instagram tools. Mirror of apify-tiktok.ts — wraps the
// apify/instagram-scraper actor to give the agent niche/competitor
// discovery (hashtag search, profile inspection) that the IG Graph
// API doesn't expose for accounts other than the authenticated one.
//
// Reuses the same Apify token loaded from user_service_keys so the
// user doesn't have to register a second integration. The actor is
// gray-ToS but well-maintained.

const ACTOR_ID = "apify~instagram-scraper";
const APIFY_BASE = "https://api.apify.com/v2";

type ApifyRunResult = Array<Record<string, unknown>>;

async function runApifyActor(
  apifyToken: string,
  input: Record<string, unknown>,
  timeoutSec = 120,
): Promise<ApifyRunResult> {
  // IG scraping is slower than TT — bump the timeout. Memory cap of
  // 1024 because the IG actor mounts a real browser session.
  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(
    apifyToken,
  )}&timeout=${timeoutSec}&memory=1024`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(
      `Apify (instagram) ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return (await res.json()) as ApifyRunResult;
}

// Compact projection of a scraped IG post — keep payloads tight so
// the agent can reason over more rows without bloating context.
function shapePost(row: Record<string, unknown>) {
  return {
    id: row.id ?? row.shortCode ?? null,
    shortcode: row.shortCode ?? null,
    type:
      (row.productType as string | undefined) ??
      (row.type as string | undefined) ??
      null, // "clips" = Reel, "feed" = post, etc.
    caption: row.caption ?? null,
    hashtags: Array.isArray(row.hashtags) ? (row.hashtags as string[]) : [],
    mentions: Array.isArray(row.mentions) ? (row.mentions as string[]) : [],
    url: row.url ?? null,
    timestamp: row.timestamp ?? null,
    likes: row.likesCount ?? null,
    comments: row.commentsCount ?? null,
    plays: row.videoPlayCount ?? row.videoViewCount ?? null,
    duration: row.videoDuration ?? null,
    owner: {
      username: row.ownerUsername ?? null,
      full_name: row.ownerFullName ?? null,
    },
  };
}

export function buildApifyInstagramTools(apifyToken: string) {
  return {
    instagram_search_hashtag: tool({
      description:
        "Find recent Instagram posts/Reels for a hashtag — niche discovery, what's trending, viral examples. Returns up to `limit` posts with stats, captions, owner, and timestamps.",
      inputSchema: z.object({
        hashtag: z
          .string()
          .describe("Hashtag WITHOUT the leading # (e.g. 'fingerstyle')"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ hashtag, limit }) => {
        const rows = await runApifyActor(apifyToken, {
          hashtags: [hashtag.replace(/^#/, "")],
          resultsType: "posts",
          resultsLimit: limit,
          searchType: "hashtag",
          addParentData: false,
        });
        return rows.slice(0, limit).map(shapePost);
      },
    }),

    instagram_get_profile: tool({
      description:
        "Inspect any public Instagram profile by username — competitor analysis. Returns the profile's recent posts/Reels with engagement metrics + captions.",
      inputSchema: z.object({
        username: z
          .string()
          .describe(
            "Instagram username WITHOUT the leading @ (e.g. 'mkbhd')",
          ),
        posts_limit: z.number().int().min(1).max(30).default(10),
      }),
      execute: async ({ username, posts_limit }) => {
        const rows = await runApifyActor(apifyToken, {
          username: [username.replace(/^@/, "")],
          resultsType: "posts",
          resultsLimit: posts_limit,
          addParentData: false,
        });
        // The actor sometimes returns a profile-header row as the
        // first item; the rest are posts. We project them all the
        // same way since the agent really wants the post engagement.
        return rows.slice(0, posts_limit).map(shapePost);
      },
    }),
  };
}
