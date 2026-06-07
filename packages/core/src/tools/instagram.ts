import { tool } from "ai";
import { z } from "zod";
import {
  describeAccounts,
  resolveAccount,
  type ProviderAccount,
} from "./account-resolver";

// Instagram Graph API tools (via Instagram Login). Read-only operations
// + comment replies. The user's connected account must be a Business
// or Creator account; personal accounts cannot use this API per Meta's
// 2024 deprecation of Basic Display.
//
// Endpoint base: https://graph.instagram.com (Instagram-Login flow)
//
// Multi-account: builder takes ALL connected IG accounts and each tool
// resolves which one to use via the `account` input parameter.

async function ig(
  token: string,
  path: string,
  init?: { method?: "GET" | "POST"; query?: Record<string, string>; body?: Record<string, string> },
): Promise<unknown> {
  const url = new URL(`https://graph.instagram.com${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString(), {
    method: init?.method ?? "GET",
    headers: init?.body
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : undefined,
    body: init?.body ? new URLSearchParams(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Instagram ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

const ACCOUNT_PARAM_DESC =
  "Which connected Instagram account to use. Optional if only one is connected; required when multiple. Call instagram_list_my_accounts first if you're unsure.";

export function buildInstagramTools(accounts: ProviderAccount[]) {
  if (accounts.length === 0) return {};

  const accountField = z.string().optional().describe(ACCOUNT_PARAM_DESC);

  async function tokenFor(account: string | undefined): Promise<string> {
    const acct = resolveAccount(accounts, account, "instagram");
    return acct.getToken();
  }

  return {
    instagram_list_my_accounts: tool({
      description:
        "List every Instagram account connected to this user. Returns [{ id, label, handle }]. ALWAYS call this first when multiple Instagram accounts may be connected, then pass `label` as the `account` argument to other instagram_* tools.",
      inputSchema: z.object({}),
      execute: async () => describeAccounts(accounts),
    }),

    instagram_get_my_account: tool({
      description:
        "Authenticated IG Business/Creator account: id, username, name, bio, follower/following/media counts.",
      inputSchema: z.object({ account: accountField }),
      execute: async ({ account }) => {
        const token = await tokenFor(account);
        return await ig(token, "/me", {
          query: {
            fields:
              "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,account_type,website",
          },
        });
      },
    }),

    instagram_list_my_media: tool({
      description:
        "User's recent IG media (posts, reels, carousels). Returns id, caption, media_type, permalink, timestamp, like_count, comments_count.",
      inputSchema: z.object({
        account: accountField,
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ account, limit }) => {
        const token = await tokenFor(account);
        const data = (await ig(token, "/me/media", {
          query: {
            fields:
              "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count",
            limit: String(limit),
          },
        })) as { data?: Array<Record<string, unknown>> };
        return data.data ?? [];
      },
    }),

    instagram_get_media_insights: tool({
      description:
        "Per-media insights: reach, impressions, saved, shares, total_interactions. Real performance beyond likes.",
      inputSchema: z.object({
        account: accountField,
        media_id: z.string(),
      }),
      execute: async ({ account, media_id }) => {
        const token = await tokenFor(account);
        // The exact metric set differs by media_type; ask for the common
        // ones and let any unsupported ones error softly per-metric.
        const data = (await ig(token, `/${media_id}/insights`, {
          query: {
            metric: "reach,impressions,saved,total_interactions,likes,comments,shares",
          },
        })) as { data?: Array<{ name: string; values?: Array<{ value: number }> }> };
        const out: Record<string, number | null> = {};
        for (const m of data.data ?? []) {
          out[m.name] = m.values?.[0]?.value ?? null;
        }
        return out;
      },
    }),

    instagram_get_account_insights: tool({
      description:
        "Account-level insights over N days: reach, profile_views, follower_count. Default 30d.",
      inputSchema: z.object({
        account: accountField,
        days: z.number().int().min(1).max(90).default(30),
      }),
      execute: async ({ account, days }) => {
        const token = await tokenFor(account);
        const until = Math.floor(Date.now() / 1000);
        const since = until - days * 86_400;
        const data = (await ig(token, "/me/insights", {
          query: {
            metric: "reach,profile_views,follower_count",
            period: "day",
            since: String(since),
            until: String(until),
          },
        })) as {
          data?: Array<{
            name: string;
            values?: Array<{ value: number; end_time?: string }>;
          }>;
        };
        return (data.data ?? []).map((m) => ({
          metric: m.name,
          total: (m.values ?? []).reduce(
            (acc, v) => acc + (typeof v.value === "number" ? v.value : 0),
            0,
          ),
          daily: m.values ?? [],
        }));
      },
    }),

    instagram_list_comments: tool({
      description:
        "Comments on a media. Returns id, text, username, timestamp, like_count.",
      inputSchema: z.object({
        account: accountField,
        media_id: z.string(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ account, media_id, limit }) => {
        const token = await tokenFor(account);
        const data = (await ig(token, `/${media_id}/comments`, {
          query: {
            fields: "id,text,username,timestamp,like_count",
            limit: String(limit),
          },
        })) as { data?: Array<Record<string, unknown>> };
        return data.data ?? [];
      },
    }),

    instagram_reply_to_comment: tool({
      description:
        "Reply to an Instagram comment. Requires the instagram_business_manage_comments scope.",
      inputSchema: z.object({
        account: accountField,
        comment_id: z.string(),
        message: z.string().min(1).max(2200),
      }),
      execute: async ({ account, comment_id, message }) => {
        const token = await tokenFor(account);
        const data = (await ig(token, `/${comment_id}/replies`, {
          method: "POST",
          body: { message },
        })) as { id?: string };
        return { id: data.id ?? null };
      },
    }),
  };
}
