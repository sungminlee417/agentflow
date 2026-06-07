import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationRow } from "../../tools";
import type { RecentFeedback, RecentReview } from "./types";

// Per-account context loaders for the video-ideas generator. The unified
// agent (unified-agent.ts) loads each connected account's bundle in
// parallel via Promise.all and feeds them all to the prompt builder.
//
// Three loaders that mirror what runVideoIdeasAgent did inline before:
//   • recent reviews (settled post-mortems from video_idea_posts)
//   • recent thumbs-down feedback (video_idea_feedback)
//   • per-account preferences (video_ideas_settings)
//
// Every loader is defensive — they swallow errors and return empty
// state. The generator can still run on partial context (e.g. fresh
// account with no reviews yet).

export type AccountContext = {
  integration: IntegrationRow;
  /** User-facing label: account_label ?? display_name ?? handle ?? "platform (id8)". */
  label: string;
  recentReviews: RecentReview[];
  recentFeedback: RecentFeedback[];
  preferences: string | null;
};

function labelFor(integration: IntegrationRow): string {
  return (
    integration.account_label?.trim() ||
    integration.display_name?.trim() ||
    integration.handle?.trim() ||
    `${integration.provider} (${integration.id.slice(0, 8)})`
  );
}

export async function loadAccountContext(
  supabase: SupabaseClient,
  userId: string,
  integration: IntegrationRow,
): Promise<AccountContext> {
  const [reviews, feedback, prefs] = await Promise.all([
    loadRecentReviews(supabase, userId, integration.id),
    loadRecentFeedback(supabase, userId, integration.id),
    loadPreferences(supabase, userId, integration.id),
  ]);
  return {
    integration,
    label: labelFor(integration),
    recentReviews: reviews,
    recentFeedback: feedback,
    preferences: prefs,
  };
}

async function loadRecentReviews(
  supabase: SupabaseClient,
  userId: string,
  integrationId: string,
): Promise<RecentReview[]> {
  try {
    const { data } = await supabase
      .from("video_idea_posts")
      .select(
        "platform, performance_verdict, performance_stats, performance_review, last_reviewed_at, video_ideas!inner(title, kind, format)",
      )
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .not("performance_verdict", "is", null)
      .neq("performance_verdict", "too_early")
      .order("last_reviewed_at", { ascending: false })
      .limit(8);

    type Row = {
      platform: string | null;
      performance_verdict: string | null;
      performance_stats: { ratio?: number } | null;
      performance_review: string | null;
      video_ideas:
        | { title?: string; kind?: string; format?: string | null }
        | Array<{ title?: string; kind?: string; format?: string | null }>
        | null;
    };

    const out: RecentReview[] = [];
    for (const row of (data ?? []) as unknown as Row[]) {
      const idea = Array.isArray(row.video_ideas)
        ? row.video_ideas[0]
        : row.video_ideas;
      if (!idea?.title || !idea.kind) continue;
      let takeaways: string | null = null;
      if (row.performance_review) {
        const tIdx = row.performance_review.indexOf("Takeaways");
        if (tIdx >= 0) {
          takeaways = row.performance_review
            .slice(tIdx)
            .replace(/^[#\s]*Takeaways[^\n]*\n?/, "")
            .trim()
            .slice(0, 400);
        }
      }
      out.push({
        title: idea.title,
        kind: idea.kind,
        format: idea.format ?? null,
        platform: row.platform ?? null,
        verdict: row.performance_verdict,
        ratio: row.performance_stats?.ratio ?? null,
        takeaways,
      });
    }
    return out;
  } catch (err) {
    console.error(
      "[video-ideas/context] loadRecentReviews failed:",
      integrationId,
      err,
    );
    return [];
  }
}

async function loadRecentFeedback(
  supabase: SupabaseClient,
  userId: string,
  integrationId: string,
): Promise<RecentFeedback[]> {
  try {
    const { data } = await supabase
      .from("video_idea_feedback")
      .select(
        "idea_title, idea_kind, idea_format, idea_hook, reason_code, free_text",
      )
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .order("created_at", { ascending: false })
      .limit(15);

    type Row = {
      idea_title: string;
      idea_kind: string;
      idea_format: string | null;
      idea_hook: string | null;
      reason_code: string;
      free_text: string | null;
    };
    return ((data ?? []) as Row[]).map((row) => ({
      title: row.idea_title,
      kind: row.idea_kind,
      format: row.idea_format,
      hook: row.idea_hook,
      reason_code: row.reason_code,
      free_text: row.free_text,
    }));
  } catch (err) {
    console.error(
      "[video-ideas/context] loadRecentFeedback failed:",
      integrationId,
      err,
    );
    return [];
  }
}

async function loadPreferences(
  supabase: SupabaseClient,
  userId: string,
  integrationId: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("video_ideas_settings")
      .select("preferences")
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .maybeSingle();
    return (data?.preferences as string | null | undefined) ?? null;
  } catch (err) {
    console.error(
      "[video-ideas/context] loadPreferences failed:",
      integrationId,
      err,
    );
    return null;
  }
}
