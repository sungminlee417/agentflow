import { tool } from "ai";
import { z } from "zod";

// TikTok Display API tools. Read-only; works in Sandbox mode with
// audited test users. Posting is in the Content Posting API which
// requires app review for non-private posts.
//
// Endpoint base: https://open.tiktokapis.com/v2

async function tt(
  token: string,
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> },
): Promise<unknown> {
  const url = new URL(`https://open.tiktokapis.com/v2${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TikTok ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

// TikTok stats fields we can request on /v2/video/list/
const VIDEO_FIELDS = [
  "id",
  "title",
  "video_description",
  "create_time",
  "cover_image_url",
  "share_url",
  "duration",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
  "embed_html",
  "embed_link",
];

export function buildTikTokTools(token: string) {
  return {
    tiktok_get_my_profile: tool({
      description:
        "Get the authenticated TikTok user's basic profile: display name, follower / following / likes / video counts, bio, avatar.",
      inputSchema: z.object({}),
      execute: async () => {
        const data = (await tt(token, "/user/info/", {
          query: {
            fields:
              "open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count",
          },
        })) as { data?: { user?: Record<string, unknown> } };
        return data.data?.user ?? null;
      },
    }),

    tiktok_list_my_videos: tool({
      description:
        "List the authenticated TikTok user's videos with stats (views, likes, comments, shares) and metadata (title, caption, duration). Returns up to `max_count` items.",
      inputSchema: z.object({
        max_count: z.number().int().min(1).max(20).default(20),
      }),
      execute: async ({ max_count }) => {
        const data = (await tt(token, "/video/list/", {
          method: "POST",
          query: { fields: VIDEO_FIELDS.join(",") },
          body: { max_count },
        })) as {
          data?: {
            videos?: Array<Record<string, unknown>>;
            cursor?: number;
            has_more?: boolean;
          };
        };
        return {
          videos: data.data?.videos ?? [],
          has_more: data.data?.has_more ?? false,
        };
      },
    }),

    tiktok_query_videos: tool({
      description:
        "Look up specific TikTok videos by id, returning full stats + metadata. Use after tiktok_list_my_videos to enrich a subset.",
      inputSchema: z.object({
        video_ids: z.array(z.string()).min(1).max(20),
      }),
      execute: async ({ video_ids }) => {
        const data = (await tt(token, "/video/query/", {
          method: "POST",
          query: { fields: VIDEO_FIELDS.join(",") },
          body: { filters: { video_ids } },
        })) as { data?: { videos?: Array<Record<string, unknown>> } };
        return data.data?.videos ?? [];
      },
    }),
  };
}

