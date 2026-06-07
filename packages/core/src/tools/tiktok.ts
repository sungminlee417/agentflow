import { tool } from "ai";
import { z } from "zod";
import {
  describeAccounts,
  resolveAccount,
  type ProviderAccount,
} from "./account-resolver";

// TikTok Display API tools. Read-only; works in Sandbox mode with
// audited test users. Posting is in the Content Posting API which
// requires app review for non-private posts.
//
// Endpoint base: https://open.tiktokapis.com/v2
//
// Multi-account: builder takes ALL connected TikTok accounts and each
// tool resolves which one to use via the `account` input parameter.

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

const ACCOUNT_PARAM_DESC =
  "Which connected TikTok account to use. Optional if only one is connected; required when multiple. Call tiktok_list_my_accounts first if you're unsure.";

export function buildTikTokTools(accounts: ProviderAccount[]) {
  if (accounts.length === 0) return {};

  const accountField = z.string().optional().describe(ACCOUNT_PARAM_DESC);

  async function tokenFor(account: string | undefined): Promise<string> {
    const acct = resolveAccount(accounts, account, "tiktok");
    return acct.getToken();
  }

  return {
    tiktok_list_my_accounts: tool({
      description:
        "List every TikTok account connected to this user. Returns [{ id, label, handle }]. ALWAYS call this first when multiple TikTok accounts may be connected, then pass `label` as the `account` argument to other tiktok_* tools.",
      inputSchema: z.object({}),
      execute: async () => describeAccounts(accounts),
    }),

    tiktok_get_my_profile: tool({
      description:
        "Get the authenticated TikTok user's basic profile: display name, follower / following / likes / video counts, bio, avatar.",
      inputSchema: z.object({ account: accountField }),
      execute: async ({ account }) => {
        const token = await tokenFor(account);
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
        account: accountField,
        max_count: z.number().int().min(1).max(20).default(20),
      }),
      execute: async ({ account, max_count }) => {
        const token = await tokenFor(account);
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

    tiktok_top_my_videos: tool({
      description:
        "Surface the authenticated TikTok user's best-performing videos by engagement rate (likes ÷ views) across their recent history. Pages through up to `from_history` videos server-side, ranks them, returns the top `top_n`. Use this to find what's actually worked for the creator over time (versus tiktok_list_my_videos which only gives you the most recent chronological slice).",
      inputSchema: z.object({
        account: accountField,
        top_n: z.number().int().min(1).max(20).default(10),
        from_history: z.number().int().min(20).max(200).default(100),
      }),
      execute: async ({ account, top_n, from_history }) => {
        const token = await tokenFor(account);
        const pageSize = 20; // TikTok's per-call max
        const collected: Array<Record<string, unknown>> = [];
        let cursor: number | undefined;
        let pages = 0;
        // Safety cap: don't burn calls if has_more lies.
        const maxPages = Math.ceil(from_history / pageSize) + 1;
        while (collected.length < from_history && pages < maxPages) {
          const body: Record<string, unknown> = { max_count: pageSize };
          if (cursor != null) body.cursor = cursor;
          const data = (await tt(token, "/video/list/", {
            method: "POST",
            query: { fields: VIDEO_FIELDS.join(",") },
            body,
          })) as {
            data?: {
              videos?: Array<Record<string, unknown>>;
              cursor?: number;
              has_more?: boolean;
            };
          };
          const batch = data.data?.videos ?? [];
          collected.push(...batch);
          pages += 1;
          if (!data.data?.has_more) break;
          cursor = data.data.cursor;
          if (cursor == null) break;
        }

        // Engagement rate with a minimum-views floor to avoid ranking
        // a 5-view fluke at 100% above a 10k-view banger at 8%.
        const VIEW_FLOOR = 50;
        const ranked = collected
          .map((v) => {
            const views = Number(v.view_count ?? 0);
            const likes = Number(v.like_count ?? 0);
            const rate = views >= VIEW_FLOOR ? likes / views : 0;
            return { v, views, likes, rate };
          })
          .filter((r) => r.views >= VIEW_FLOOR)
          .sort((a, b) => b.rate - a.rate)
          .slice(0, top_n)
          .map((r) => ({
            ...r.v,
            _engagement_rate: Number(r.rate.toFixed(4)),
          }));

        return {
          videos: ranked,
          considered: collected.length,
          ranked_by: "likes / views (with min 50 views)",
        };
      },
    }),

    tiktok_query_videos: tool({
      description:
        "Look up specific TikTok videos by id, returning full stats + metadata. Use after tiktok_list_my_videos to enrich a subset.",
      inputSchema: z.object({
        account: accountField,
        video_ids: z.array(z.string()).min(1).max(20),
      }),
      execute: async ({ account, video_ids }) => {
        const token = await tokenFor(account);
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
