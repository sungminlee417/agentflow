import { tool } from "ai";
import { z } from "zod";
import {
  describeAccounts,
  resolveAccount,
  type ProviderAccount,
} from "./account-resolver";

// YouTube tools. Use the Data API v3 for content + the Analytics API
// for engagement metrics. Authenticated calls use the user's OAuth
// token (Bearer).
//
// Multi-account: builder takes ALL connected YouTube accounts and each
// tool resolves which one to use via the `account` input parameter.

async function yt(token: string, path: string): Promise<unknown> {
  const url = path.startsWith("http")
    ? path
    : `https://www.googleapis.com/youtube/v3${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`YouTube ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function ytAnalytics(
  token: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`YouTube Analytics ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Lowercase to keep the param description identical across providers.
const ACCOUNT_PARAM_DESC =
  "Which connected YouTube account to use. Optional if only one is connected; required when multiple. Call youtube_list_my_accounts first if you're unsure.";

export function buildYouTubeTools(accounts: ProviderAccount[]) {
  if (accounts.length === 0) return {};

  const accountField = z
    .string()
    .optional()
    .describe(ACCOUNT_PARAM_DESC);

  async function tokenFor(account: string | undefined): Promise<string> {
    const acct = resolveAccount(accounts, account, "youtube");
    return acct.getToken();
  }

  return {
    youtube_list_my_accounts: tool({
      description:
        "List every YouTube account connected to this user. Returns [{ id, label, handle }]. ALWAYS call this first when multiple YouTube accounts may be connected, then pass `label` as the `account` argument to other youtube_* tools.",
      inputSchema: z.object({}),
      execute: async () => describeAccounts(accounts),
    }),

    youtube_get_my_channel: tool({
      description:
        "Authenticated user's channel: id, title, subscriber/view/video counts. Call once to anchor 'my channel'.",
      inputSchema: z.object({ account: accountField }),
      execute: async ({ account }) => {
        const token = await tokenFor(account);
        const data = (await yt(
          token,
          "/channels?part=snippet,statistics,contentDetails&mine=true",
        )) as {
          items?: Array<{
            id: string;
            snippet?: {
              title?: string;
              description?: string;
              customUrl?: string;
              publishedAt?: string;
              defaultLanguage?: string;
            };
            statistics?: {
              viewCount?: string;
              subscriberCount?: string;
              videoCount?: string;
            };
            contentDetails?: {
              relatedPlaylists?: { uploads?: string };
            };
          }>;
        };
        const c = data.items?.[0];
        if (!c) throw new Error("No channel found for this account.");
        return {
          id: c.id,
          title: c.snippet?.title ?? null,
          description: c.snippet?.description ?? null,
          custom_url: c.snippet?.customUrl ?? null,
          published_at: c.snippet?.publishedAt ?? null,
          subscribers: c.statistics?.subscriberCount ?? null,
          total_views: c.statistics?.viewCount ?? null,
          video_count: c.statistics?.videoCount ?? null,
          uploads_playlist_id:
            c.contentDetails?.relatedPlaylists?.uploads ?? null,
        };
      },
    }),

    youtube_list_my_videos: tool({
      description:
        "User's most recent uploads. Returns id, title, description, publishedAt, thumbnail, tags, duration, stats (views/likes/comments).",
      inputSchema: z.object({
        account: accountField,
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ account, limit }) => {
        const token = await tokenFor(account);
        // 1. Find the uploads playlist id.
        const channels = (await yt(
          token,
          "/channels?part=contentDetails&mine=true",
        )) as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
        const uploadsId =
          channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsId) throw new Error("No uploads playlist found.");

        // 2. List items in the uploads playlist.
        const list = (await yt(
          token,
          `/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=${limit}`,
        )) as {
          items?: Array<{
            contentDetails?: { videoId?: string };
          }>;
        };
        const ids = (list.items ?? [])
          .map((i) => i.contentDetails?.videoId)
          .filter((id): id is string => !!id);
        if (ids.length === 0) return [];

        // 3. Batch lookup videos for snippet + stats.
        const videos = (await yt(
          token,
          `/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`,
        )) as {
          items?: Array<{
            id: string;
            snippet?: {
              title?: string;
              description?: string;
              publishedAt?: string;
              thumbnails?: Record<string, { url?: string }>;
              tags?: string[];
            };
            statistics?: {
              viewCount?: string;
              likeCount?: string;
              commentCount?: string;
            };
            contentDetails?: { duration?: string };
          }>;
        };
        return (videos.items ?? []).map((v) => ({
          id: v.id,
          title: v.snippet?.title ?? null,
          description: v.snippet?.description?.slice(0, 500) ?? null,
          published_at: v.snippet?.publishedAt ?? null,
          thumbnail:
            v.snippet?.thumbnails?.maxres?.url ??
            v.snippet?.thumbnails?.high?.url ??
            null,
          tags: v.snippet?.tags ?? [],
          duration: v.contentDetails?.duration ?? null,
          views: v.statistics?.viewCount ?? null,
          likes: v.statistics?.likeCount ?? null,
          comments: v.statistics?.commentCount ?? null,
        }));
      },
    }),

    youtube_get_video_analytics: tool({
      description:
        "Per-video Analytics API metrics: views, watch time, avg view duration, avg view %, likes, subscribers gained, CTR. The real performance picture beyond public counts.",
      inputSchema: z.object({
        account: accountField,
        video_id: z.string(),
        start_date: z
          .string()
          .optional()
          .describe(
            "YYYY-MM-DD. Defaults to 90 days ago.",
          ),
        end_date: z
          .string()
          .optional()
          .describe("YYYY-MM-DD. Defaults to today."),
      }),
      execute: async ({ account, video_id, start_date, end_date }) => {
        const token = await tokenFor(account);
        const end = end_date ?? new Date().toISOString().slice(0, 10);
        const startDefault = new Date(Date.now() - 90 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const start = start_date ?? startDefault;
        const data = (await ytAnalytics(token, {
          ids: "channel==MINE",
          startDate: start,
          endDate: end,
          metrics:
            "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares,annotationClickThroughRate,annotationCloseRate,cardClickRate,cardTeaserClickRate",
          filters: `video==${video_id}`,
        })) as {
          columnHeaders?: Array<{ name: string }>;
          rows?: Array<Array<number | string>>;
        };
        const header = data.columnHeaders?.map((h) => h.name) ?? [];
        const row = data.rows?.[0] ?? [];
        const out: Record<string, number | string | null> = {};
        for (let i = 0; i < header.length; i++) {
          out[header[i]!] = row[i] ?? null;
        }
        return { range: { start, end }, metrics: out };
      },
    }),

    youtube_get_video_traffic_sources: tool({
      description:
        "Traffic-source breakdown for a video (Search vs Suggested vs Browse vs External). Rows of { source, views, watch_time_minutes }.",
      inputSchema: z.object({
        account: accountField,
        video_id: z.string(),
        days: z.number().int().min(1).max(365).default(28),
      }),
      execute: async ({ account, video_id, days }) => {
        const token = await tokenFor(account);
        const end = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - days * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const data = (await ytAnalytics(token, {
          ids: "channel==MINE",
          startDate: start,
          endDate: end,
          metrics: "views,estimatedMinutesWatched",
          dimensions: "insightTrafficSourceType",
          sort: "-views",
          filters: `video==${video_id}`,
        })) as { rows?: Array<[string, number, number]> };
        return (data.rows ?? []).map(([source, views, watchTime]) => ({
          source,
          views,
          watch_time_minutes: watchTime,
        }));
      },
    }),

    youtube_search_niche: tool({
      description:
        "Search YouTube by query — discover niche/competitor videos. Returns id, title, channel, publishedAt, views, likes.",
      inputSchema: z.object({
        account: accountField,
        query: z.string(),
        max_results: z.number().int().min(1).max(50).default(15),
        published_after_days: z.number().int().min(1).max(3650).default(30),
        order: z
          .enum(["relevance", "date", "rating", "viewCount", "title"])
          .default("relevance"),
      }),
      execute: async ({ account, query, max_results, published_after_days, order }) => {
        const token = await tokenFor(account);
        const publishedAfter = new Date(
          Date.now() - published_after_days * 86_400_000,
        ).toISOString();
        const search = (await yt(
          token,
          `/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${max_results}&order=${order}&publishedAfter=${encodeURIComponent(publishedAfter)}`,
        )) as {
          items?: Array<{
            id?: { videoId?: string };
            snippet?: {
              title?: string;
              channelTitle?: string;
              publishedAt?: string;
              description?: string;
            };
          }>;
        };
        const ids = (search.items ?? [])
          .map((i) => i.id?.videoId)
          .filter((id): id is string => !!id);
        if (ids.length === 0) return [];

        // Enrich with statistics in one batch.
        const details = (await yt(
          token,
          `/videos?part=statistics&id=${ids.join(",")}`,
        )) as {
          items?: Array<{
            id: string;
            statistics?: { viewCount?: string; likeCount?: string };
          }>;
        };
        const statById = new Map<
          string,
          { views: string | null; likes: string | null }
        >();
        for (const v of details.items ?? []) {
          statById.set(v.id, {
            views: v.statistics?.viewCount ?? null,
            likes: v.statistics?.likeCount ?? null,
          });
        }

        return (search.items ?? []).map((i) => {
          const id = i.id?.videoId ?? "";
          return {
            id,
            title: i.snippet?.title ?? null,
            channel: i.snippet?.channelTitle ?? null,
            published_at: i.snippet?.publishedAt ?? null,
            description: i.snippet?.description?.slice(0, 200) ?? null,
            views: statById.get(id)?.views ?? null,
            likes: statById.get(id)?.likes ?? null,
          };
        });
      },
    }),

    youtube_get_video_comments: tool({
      description:
        "Top-level comments on a video — audience sentiment + common questions.",
      inputSchema: z.object({
        account: accountField,
        video_id: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async ({ account, video_id, limit }) => {
        const token = await tokenFor(account);
        const data = (await yt(
          token,
          `/commentThreads?part=snippet&videoId=${video_id}&maxResults=${limit}&order=relevance`,
        )) as {
          items?: Array<{
            snippet?: {
              topLevelComment?: {
                snippet?: {
                  authorDisplayName?: string;
                  textDisplay?: string;
                  likeCount?: number;
                  publishedAt?: string;
                };
              };
              totalReplyCount?: number;
            };
          }>;
        };
        return (data.items ?? []).map((t) => {
          const c = t.snippet?.topLevelComment?.snippet;
          return {
            author: c?.authorDisplayName ?? null,
            text: c?.textDisplay ?? null,
            likes: c?.likeCount ?? 0,
            published_at: c?.publishedAt ?? null,
            reply_count: t.snippet?.totalReplyCount ?? 0,
          };
        });
      },
    }),

    youtube_reply_to_comment: tool({
      description:
        "Post a reply to a YouTube comment. Requires the youtube.force-ssl scope (granted on reconnect after 2026-06-07). Returns the new reply id.",
      inputSchema: z.object({
        account: accountField,
        parent_comment_id: z
          .string()
          .describe("The id of the comment you're replying to."),
        text: z.string().min(1).max(10000),
      }),
      execute: async ({ account, parent_comment_id, text }) => {
        const token = await tokenFor(account);
        const res = await fetch(
          "https://www.googleapis.com/youtube/v3/comments?part=snippet",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              snippet: { parentId: parent_comment_id, textOriginal: text },
            }),
          },
        );
        const body = await res.text();
        if (!res.ok) {
          throw new Error(`YouTube reply ${res.status}: ${body.slice(0, 500)}`);
        }
        try {
          const json = JSON.parse(body) as { id?: string };
          return { id: json.id ?? null };
        } catch {
          return { id: null };
        }
      },
    }),
  };
}
