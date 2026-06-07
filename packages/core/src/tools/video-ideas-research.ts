import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

// Per-idea review + feedback retrieval. The video-ideas generator calls
// these when it wants targeted history on a specific format/topic it's
// considering — rather than relying on the global "latest N" dump baked
// into the system prompt. Two reasons this exists:
//
//   1. SCALE — once the back catalogue has hundreds (let alone
//      thousands) of reviewed posts, dumping the latest N globally
//      blows the prompt budget AND wastes attention on irrelevant
//      learnings. Targeted retrieval keeps tokens tight.
//
//   2. RELEVANCE — when the agent is sketching a "comparison Bach
//      piece" idea, the right signal is past comparison-Bach posts,
//      not the most recent unrelated tutorial. Filtering by
//      format/kind/title keywords narrows directly to relevant prior
//      work.
//
// Multi-account: the unified video-ideas agent sees ALL connected
// integrations at once, so each tool takes a `target_integration_id`
// input naming WHICH account the lookup is scoped to. Cross-account
// learnings stay siloed (a music-TT rejection doesn't taint the
// fitness-IG lane) but the agent can ask "what's worked for Sungmin's
// YT?" while simultaneously planning ideas for Hammy's IG.
//
// The set of valid ids is captured in closure at builder time; the
// execute path validates against it to defend against the model
// fabricating an integration id from prompt text.

export function buildVideoIdeasResearchTools(
  supabase: SupabaseClient,
  userId: string,
  integrationIds: string[],
) {
  const valid = new Set(integrationIds);

  function assertValid(id: string): void {
    if (!valid.has(id)) {
      throw new Error(
        `Unknown target_integration_id: ${id}. Valid ids: ${[...valid].join(", ") || "(none)"}.`,
      );
    }
  }

  return {
    video_ideas_find_similar_reviews: tool({
      description:
        "Look up post-mortems from ONE account's back catalogue similar to an idea you're considering. Filter by format (substring match), kind, and/or title keywords. Use BEFORE finalising any idea you're unsure about — past hits/flops on the same format are the strongest signal for whether to commit to it. Returns title, kind, format, platform, verdict (hit/on_track/underperformed), ratio vs creator's median, and the post-mortem's Takeaways section.",
      inputSchema: z.object({
        target_integration_id: z
          .string()
          .uuid()
          .describe(
            "Which connected account this lookup is scoped to. Pass the integration_id of the account you're considering the idea FOR (not the account you're inspecting evidence ABOUT). Required.",
          ),
        format: z
          .string()
          .optional()
          .describe(
            'Substring of the format field. E.g. "comparison" matches "acoustic vs classical comparison".',
          ),
        kind: z
          .enum(["pattern", "trend", "rising", "competitor", "seasonal"])
          .optional()
          .describe("Restrict to ideas of this kind."),
        title_keywords: z
          .array(z.string())
          .optional()
          .describe(
            'Words that should appear in the idea title (case-insensitive substring match, ANY match counts). E.g. ["bach", "classical"].',
          ),
        limit: z.number().int().min(1).max(20).default(8),
      }),
      execute: async ({
        target_integration_id,
        format,
        kind,
        title_keywords,
        limit,
      }) => {
        assertValid(target_integration_id);
        let q = supabase
          .from("video_idea_posts")
          .select(
            "platform, performance_verdict, performance_stats, performance_review, last_reviewed_at, video_ideas!inner(title, kind, format)",
          )
          .eq("user_id", userId)
          .eq("integration_id", target_integration_id)
          .not("performance_verdict", "is", null)
          .neq("performance_verdict", "too_early")
          .order("last_reviewed_at", { ascending: false })
          .limit(limit);

        if (kind) {
          q = q.eq("video_ideas.kind", kind);
        }
        if (format && format.trim()) {
          q = q.ilike("video_ideas.format", `%${format.trim()}%`);
        }
        if (title_keywords && title_keywords.length > 0) {
          const or = title_keywords
            .map((k) => `title.ilike.%${k.trim().replace(/[%,]/g, "")}%`)
            .join(",");
          q = q.or(or, { referencedTable: "video_ideas" });
        }

        const { data, error } = await q;
        if (error) {
          throw new Error(`find_similar_reviews failed: ${error.message}`);
        }

        type Row = {
          platform: string | null;
          performance_verdict: string | null;
          performance_stats: { ratio?: number; views?: number } | null;
          performance_review: string | null;
          last_reviewed_at: string | null;
          video_ideas:
            | { title?: string; kind?: string; format?: string | null }
            | Array<{ title?: string; kind?: string; format?: string | null }>
            | null;
        };

        return (data as unknown as Row[]).map((row) => {
          const idea = Array.isArray(row.video_ideas)
            ? row.video_ideas[0]
            : row.video_ideas;
          let takeaways: string | null = null;
          if (row.performance_review) {
            const tIdx = row.performance_review.indexOf("Takeaways");
            if (tIdx >= 0) {
              takeaways = row.performance_review
                .slice(tIdx)
                .replace(/^[#\s]*Takeaways[^\n]*\n?/, "")
                .trim()
                .slice(0, 600);
            }
          }
          return {
            title: idea?.title ?? null,
            kind: idea?.kind ?? null,
            format: idea?.format ?? null,
            platform: row.platform,
            verdict: row.performance_verdict,
            ratio: row.performance_stats?.ratio ?? null,
            views: row.performance_stats?.views ?? null,
            takeaways,
            reviewed_at: row.last_reviewed_at,
          };
        });
      },
    }),

    video_ideas_find_recent_feedback: tool({
      description:
        "Look up the creator's recent thumbs-down rejections for ONE account. Use BEFORE proposing any idea similar to recent rejections — past 'this won't work' signals are the strongest reason to NOT regenerate something. Returns title, kind, format, hook, reason_code (outdated_trend / wrong_voice / flopped_before / platform_wrong / off_brand / other) and the creator's free-text note when present.",
      inputSchema: z.object({
        target_integration_id: z
          .string()
          .uuid()
          .describe(
            "Which connected account this lookup is scoped to. Pass the integration_id of the account you're considering the idea FOR. Required.",
          ),
        reason_code: z
          .enum([
            "outdated_trend",
            "wrong_voice",
            "flopped_before",
            "platform_wrong",
            "off_brand",
            "other",
          ])
          .optional()
          .describe(
            "Restrict to rejections of a specific failure mode. E.g. 'outdated_trend' to see what trends the creator has called dead.",
          ),
        kind: z
          .enum(["pattern", "trend", "rising", "competitor", "seasonal"])
          .optional()
          .describe("Restrict to rejections of one kind."),
        limit: z.number().int().min(1).max(30).default(15),
      }),
      execute: async ({ target_integration_id, reason_code, kind, limit }) => {
        assertValid(target_integration_id);
        let q = supabase
          .from("video_idea_feedback")
          .select(
            "idea_title, idea_kind, idea_format, idea_hook, reason_code, free_text, created_at",
          )
          .eq("user_id", userId)
          .eq("integration_id", target_integration_id)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (reason_code) q = q.eq("reason_code", reason_code);
        if (kind) q = q.eq("idea_kind", kind);
        const { data, error } = await q;
        if (error) {
          throw new Error(`find_recent_feedback failed: ${error.message}`);
        }
        return (data ?? []).map((row) => ({
          title: row.idea_title,
          kind: row.idea_kind,
          format: row.idea_format,
          hook: row.idea_hook,
          reason_code: row.reason_code,
          free_text: row.free_text,
          created_at: row.created_at,
        }));
      },
    }),
  };
}
