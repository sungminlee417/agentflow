import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

// Apify-backed TikTok tools. These wrap the clockworks/tiktok-scraper
// actor, which scrapes public TikTok pages — useful for things the
// Display API can't give us (niche search, competitor profiles,
// hashtag exploration).
//
// Requires the user's own Apify API key (BYOK via user_service_keys)
// since each call costs credits. The Apify actor is gray-ToS but
// reliable; the legal/contractual risk lives with Apify, not us.

const ACTOR_ID = "clockworks~tiktok-scraper";
const APIFY_BASE = "https://api.apify.com/v2";

type ApifyRunResult = Array<Record<string, unknown>>;

async function runApifyActor(
  apifyToken: string,
  input: Record<string, unknown>,
  timeoutSec = 90,
): Promise<ApifyRunResult> {
  // run-sync-get-dataset-items returns the dataset rows directly once
  // the run finishes (or times out).
  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(
    apifyToken,
  )}&timeout=${timeoutSec}&memory=512`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(
      `Apify ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return (await res.json()) as ApifyRunResult;
}

// Compact projection of a scraped TikTok video — keep the agent's
// context bounded so it can reason over more rows.
function shapeVideo(row: Record<string, unknown>) {
  const author = row.authorMeta as Record<string, unknown> | undefined;
  const stats =
    (row.stats as Record<string, unknown> | undefined) ??
    (row.statsV2 as Record<string, unknown> | undefined);
  const music = row.musicMeta as Record<string, unknown> | undefined;
  return {
    id: row.id ?? row.videoId ?? null,
    text: row.text ?? row.caption ?? null,
    create_time:
      typeof row.createTimeISO === "string"
        ? row.createTimeISO
        : row.createTime ?? null,
    duration: row.videoMeta
      ? (row.videoMeta as Record<string, unknown>).duration
      : null,
    web_video_url: row.webVideoUrl ?? row.url ?? null,
    author: author
      ? {
          name: author.name ?? null,
          nickname: author.nickName ?? null,
          followers: author.fans ?? author.followers ?? null,
        }
      : null,
    stats: stats
      ? {
          plays: stats.playCount ?? stats.viewCount ?? null,
          likes: stats.diggCount ?? stats.likeCount ?? null,
          comments: stats.commentCount ?? null,
          shares: stats.shareCount ?? null,
        }
      : null,
    hashtags: Array.isArray(row.hashtags)
      ? (row.hashtags as Array<{ name?: string }>).map((h) => h?.name).filter(Boolean)
      : [],
    music: music
      ? {
          name: music.musicName ?? null,
          author: music.musicAuthor ?? null,
          original: music.musicOriginal ?? null,
        }
      : null,
  };
}

export function buildApifyTikTokTools(apifyToken: string) {
  return {
    tiktok_search_hashtag: tool({
      description:
        "Find recent TikTok videos for a hashtag — use to spot what's trending in a niche, surface viral examples, or sanity-check whether a topic has lift right now. Returns up to `limit` recent videos with stats, captions, and music.",
      inputSchema: z.object({
        hashtag: z
          .string()
          .describe("Hashtag WITHOUT the leading # (e.g. 'fitness', 'ai_tools')"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ hashtag, limit }) => {
        const rows = await runApifyActor(apifyToken, {
          hashtags: [hashtag.replace(/^#/, "")],
          resultsPerPage: limit,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        });
        return rows.slice(0, limit).map(shapeVideo);
      },
    }),

    tiktok_search_keyword: tool({
      description:
        "Search TikTok by keyword (not hashtag). Useful for natural-language topic exploration — e.g. 'productivity desk setup' or 'mediterranean diet meal prep'.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ query, limit }) => {
        const rows = await runApifyActor(apifyToken, {
          searchQueries: [query],
          resultsPerPage: limit,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        });
        return rows.slice(0, limit).map(shapeVideo);
      },
    }),

    tiktok_get_profile: tool({
      description:
        "Inspect any public TikTok profile by username — use for competitor analysis. Returns profile stats and that user's recent videos with engagement metrics.",
      inputSchema: z.object({
        username: z
          .string()
          .describe("TikTok username WITHOUT the leading @ (e.g. 'mrbeast')"),
        videos_limit: z.number().int().min(1).max(30).default(10),
      }),
      execute: async ({ username, videos_limit }) => {
        const rows = await runApifyActor(apifyToken, {
          profiles: [username.replace(/^@/, "")],
          resultsPerPage: videos_limit,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        });
        if (rows.length === 0) return { profile: null, videos: [] };
        const first = rows[0]!;
        const author = first.authorMeta as Record<string, unknown> | undefined;
        return {
          profile: author
            ? {
                name: author.name ?? null,
                nickname: author.nickName ?? null,
                followers: author.fans ?? null,
                following: author.following ?? null,
                hearts: author.heart ?? null,
                video_count: author.video ?? null,
                bio: author.signature ?? null,
                verified: author.verified ?? null,
              }
            : null,
          videos: rows.slice(0, videos_limit).map(shapeVideo),
        };
      },
    }),
  };
}

// Load + decrypt the user's Apify key. Returns null if not configured.
export async function loadApifyKey(
  supabase: SupabaseClient,
  userId: string,
  decrypt: (s: string) => string,
): Promise<string | null> {
  const { data } = await supabase
    .from("user_service_keys")
    .select("encrypted_key")
    .eq("user_id", userId)
    .eq("service", "apify")
    .maybeSingle();
  if (!data?.encrypted_key) return null;
  try {
    return decrypt(data.encrypted_key);
  } catch {
    return null;
  }
}
