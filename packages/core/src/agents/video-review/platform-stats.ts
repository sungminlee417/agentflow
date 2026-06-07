// Per-platform stats fetchers. Each returns a normalised PlatformStats
// shape so the verdict + LLM prompt machinery downstream stays
// platform-agnostic. Used by the review pipeline (runPostReview +
// runVideoReview) to pull actual numbers for a video the creator
// already posted.

export type PlatformStats = {
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

// ─────────────────────────────────────────────────────────────────────
// TikTok — Display API
// ─────────────────────────────────────────────────────────────────────

type TikTokVideo = {
  id?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  create_time?: number;
  title?: string;
  video_description?: string;
};

export const TT_FIELDS = [
  "id",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
  "create_time",
  "title",
  "video_description",
].join(",");

export async function tt(
  token: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string>;
  } = {},
): Promise<unknown> {
  const url = new URL(`https://open.tiktokapis.com/v2${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TikTok ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export async function fetchTikTokStats(
  token: string,
  videoId: string,
): Promise<PlatformStats | null> {
  const data = (await tt(token, "/video/query/", {
    method: "POST",
    query: { fields: TT_FIELDS },
    body: { filters: { video_ids: [videoId] } },
  })) as { data?: { videos?: TikTokVideo[] } };
  const v = data.data?.videos?.[0];
  if (!v) return null;
  return {
    views: v.view_count ?? 0,
    likes: v.like_count ?? 0,
    comments: v.comment_count ?? 0,
    shares: v.share_count ?? 0,
  };
}

export async function fetchTikTokBaselineRates(token: string): Promise<number[]> {
  try {
    const data = (await tt(token, "/video/list/", {
      method: "POST",
      query: { fields: TT_FIELDS },
      body: { max_count: 20 },
    })) as { data?: { videos?: TikTokVideo[] } };
    const VIEW_FLOOR = 50;
    return (data.data?.videos ?? [])
      .filter((v) => (v.view_count ?? 0) >= VIEW_FLOOR)
      .map((v) => (v.like_count ?? 0) / Math.max(1, v.view_count ?? 1));
  } catch {
    return [];
  }
}

// Also export the shaper for callers that need a TikTok video row (used
// by video-metadata.ts).
export type { TikTokVideo };

// ─────────────────────────────────────────────────────────────────────
// YouTube — Data API v3
// ─────────────────────────────────────────────────────────────────────

export async function fetchYouTubeStats(
  token: string,
  videoId: string,
): Promise<PlatformStats | null> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`YouTube ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
    }>;
  };
  const stats = json.items?.[0]?.statistics;
  if (!stats) return null;
  return {
    views: Number(stats.viewCount ?? 0),
    likes: Number(stats.likeCount ?? 0),
    comments: Number(stats.commentCount ?? 0),
    // YouTube doesn't expose share count in Data API; left at 0.
    shares: 0,
  };
}

export async function fetchYouTubeBaselineRates(token: string): Promise<number[]> {
  try {
    // search.list with forMine=true gets the authenticated user's
    // most recent uploads. order=date, type=video. Then fetch the
    // statistics block in a second call.
    const searchUrl =
      "https://www.googleapis.com/youtube/v3/search?part=id&forMine=true&type=video&order=date&maxResults=20";
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!searchRes.ok) return [];
    const searchJson = (await searchRes.json()) as {
      items?: Array<{ id?: { videoId?: string } }>;
    };
    const ids = (searchJson.items ?? [])
      .map((i) => i.id?.videoId)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return [];
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(",")}`;
    const statsRes = await fetch(statsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!statsRes.ok) return [];
    const statsJson = (await statsRes.json()) as {
      items?: Array<{
        statistics?: { viewCount?: string; likeCount?: string };
      }>;
    };
    const VIEW_FLOOR = 50;
    return (statsJson.items ?? [])
      .map((item) => ({
        views: Number(item.statistics?.viewCount ?? 0),
        likes: Number(item.statistics?.likeCount ?? 0),
      }))
      .filter((r) => r.views >= VIEW_FLOOR)
      .map((r) => r.likes / Math.max(1, r.views));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Instagram — Graph API (Business Login flow)
// ─────────────────────────────────────────────────────────────────────

// Instagram Graph API. Caller passes the shortcode from the URL; we
// resolve it to a media id via /me/media (Instagram doesn't expose
// shortcode → id directly).
export async function fetchInstagramMediaIdByShortcode(
  token: string,
  shortcode: string,
): Promise<string | null> {
  const url = `https://graph.instagram.com/me/media?fields=id,shortcode&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: Array<{ id?: string; shortcode?: string }>;
  };
  const hit = (json.data ?? []).find((m) => m.shortcode === shortcode);
  return hit?.id ?? null;
}

export async function fetchInstagramStats(
  token: string,
  shortcodeOrId: string,
): Promise<PlatformStats | null> {
  let mediaId = shortcodeOrId;
  // If it looks like a shortcode (non-numeric), resolve it.
  if (!/^\d+$/.test(shortcodeOrId)) {
    const resolved = await fetchInstagramMediaIdByShortcode(
      token,
      shortcodeOrId,
    );
    if (!resolved) return null;
    mediaId = resolved;
  }
  const url = `https://graph.instagram.com/${mediaId}?fields=like_count,comments_count,media_type&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const base = (await res.json()) as {
    like_count?: number;
    comments_count?: number;
    media_type?: string;
  };
  // Reach/impressions live behind /insights for business accounts.
  let views = 0;
  let shares = 0;
  try {
    const insightsUrl = `https://graph.instagram.com/${mediaId}/insights?metric=reach,shares&access_token=${encodeURIComponent(token)}`;
    const insightsRes = await fetch(insightsUrl);
    if (insightsRes.ok) {
      const ij = (await insightsRes.json()) as {
        data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
      };
      for (const m of ij.data ?? []) {
        const v = m.values?.[0]?.value ?? 0;
        if (m.name === "reach") views = v;
        if (m.name === "shares") shares = v;
      }
    }
  } catch {
    // Insights are optional; we fall back to 0.
  }
  return {
    views,
    likes: base.like_count ?? 0,
    comments: base.comments_count ?? 0,
    shares,
  };
}

export async function fetchInstagramBaselineRates(token: string): Promise<number[]> {
  try {
    const url = `https://graph.instagram.com/me/media?fields=id,media_type&limit=20&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id);
    const rates: number[] = [];
    for (const id of ids) {
      try {
        const detailUrl = `https://graph.instagram.com/${id}?fields=like_count,comments_count&access_token=${encodeURIComponent(token)}`;
        const detailRes = await fetch(detailUrl);
        if (!detailRes.ok) continue;
        const d = (await detailRes.json()) as {
          like_count?: number;
          comments_count?: number;
        };
        const insightsUrl = `https://graph.instagram.com/${id}/insights?metric=reach&access_token=${encodeURIComponent(token)}`;
        const insightsRes = await fetch(insightsUrl);
        let reach = 0;
        if (insightsRes.ok) {
          const ij = (await insightsRes.json()) as {
            data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
          };
          reach =
            ij.data?.find((m) => m.name === "reach")?.values?.[0]?.value ?? 0;
        }
        const VIEW_FLOOR = 50;
        if (reach >= VIEW_FLOOR) {
          rates.push((d.like_count ?? 0) / Math.max(1, reach));
        }
      } catch {
        // Individual misses don't sink the whole baseline.
      }
    }
    return rates;
  } catch {
    return [];
  }
}
