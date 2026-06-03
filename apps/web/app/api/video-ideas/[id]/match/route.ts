import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, getFreshAccessToken } from "@agentflow/core";

// Suggest recent TikTok uploads that might be the video this idea
// produced. Used by the Mark-done modal to pre-select a likely match.
//
// Scoring is intentionally lightweight (hashtag overlap × recency):
//   • +5 per shared hashtag with the idea's hashtags list
//   • +1 if the video's caption contains a word from the idea's title
//     (length > 4 to skip stopwords)
//   • -1 per day of age (so a perfect-match-but-2-months-old loses to
//     a moderate match from yesterday)
//
// Returns the top 5 candidates with the score so the UI can show
// confidence. Caller decides whether to auto-pre-select or just
// suggest.

type TikTokVideo = {
  id?: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  view_count?: number;
  like_count?: number;
  share_url?: string;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data: idea } = await supabase
    .from("video_ideas")
    .select("id, integration_id, title, hashtags")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (!idea) return new NextResponse("Idea not found", { status: 404 });

  const { data: integration } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("user_id", user.id)
    .eq("id", idea.integration_id)
    .maybeSingle();
  if (!integration?.encrypted_access_token) {
    return NextResponse.json({ matches: [] });
  }
  if (integration.provider !== "tiktok") {
    return NextResponse.json({ matches: [] });
  }

  let token: string;
  try {
    token = await getFreshAccessToken(supabase, user.id, "tiktok", {
      encrypted_access_token: integration.encrypted_access_token,
      encrypted_refresh_token: integration.encrypted_refresh_token,
      expires_at: integration.expires_at,
    });
  } catch {
    token = decrypt(integration.encrypted_access_token);
  }

  let videos: TikTokVideo[] = [];
  try {
    const res = await fetch(
      "https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,view_count,like_count,share_url",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ max_count: 10 }),
      },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        data?: { videos?: TikTokVideo[] };
      };
      videos = json.data?.videos ?? [];
    }
  } catch (err) {
    console.error("[video-ideas/match] tiktok fetch failed:", err);
  }

  const ideaHashtags = new Set(
    ((idea.hashtags as string[] | null) ?? []).map((h) =>
      h.toLowerCase().replace(/^#/, ""),
    ),
  );
  const titleWords = new Set(
    (idea.title as string)
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 4),
  );

  const now = Date.now();
  const scored = videos
    .filter((v) => v.id)
    .map((v) => {
      const caption = `${v.title ?? ""} ${v.video_description ?? ""}`.toLowerCase();
      const hashtagsInCaption = (caption.match(/#\w+/g) ?? []).map((h) =>
        h.replace(/^#/, ""),
      );
      let score = 0;
      let matchedTags: string[] = [];
      for (const tag of hashtagsInCaption) {
        if (ideaHashtags.has(tag)) {
          score += 5;
          matchedTags.push(tag);
        }
      }
      for (const word of titleWords) {
        if (caption.includes(word)) score += 1;
      }
      const ageDays = v.create_time
        ? Math.max(0, (now - v.create_time * 1000) / 86_400_000)
        : 0;
      score -= ageDays;

      return {
        id: v.id!,
        url:
          v.share_url ??
          (v.id ? `https://www.tiktok.com/video/${v.id}` : null),
        caption: (v.video_description ?? v.title ?? "").slice(0, 200),
        posted_at: v.create_time
          ? new Date(v.create_time * 1000).toISOString()
          : null,
        views: v.view_count ?? 0,
        likes: v.like_count ?? 0,
        score: Number(score.toFixed(2)),
        age_days: Number(ageDays.toFixed(1)),
        matched_hashtags: matchedTags,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return NextResponse.json({ matches: scored });
}
