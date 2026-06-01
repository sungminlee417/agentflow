import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

// Tools for reading the user's manually-uploaded creator analytics
// exports (CSV/JSON from TikTok Studio, YouTube Studio, IG Insights).
//
// These are the most valuable analytics surface — retention curves,
// traffic sources, watch time — none of which the platforms' APIs
// expose to third parties. The agent gets it because the creator
// drags the file in.

export function buildUploadsTools(supabase: SupabaseClient, userId: string) {
  return {
    list_my_analytics_uploads: tool({
      description:
        "List the user's manually-uploaded analytics exports (e.g. TikTok Studio CSV, YouTube Studio export). Returns just metadata (label, provider, size, date). Call before getting content so you know what's available.",
      inputSchema: z.object({
        provider: z
          .enum(["tiktok", "youtube", "instagram"])
          .optional()
          .describe("Filter by platform. Omit to see all."),
      }),
      execute: async ({ provider }) => {
        let q = supabase
          .from("creator_analytics_uploads")
          .select("id, provider, label, filename, content_type, size_bytes, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });
        if (provider) q = q.eq("provider", provider);
        const { data } = await q;
        return data ?? [];
      },
    }),

    get_analytics_upload: tool({
      description:
        "Read the full text content of a previously-uploaded analytics export by id. CSV/JSON come back as raw text — parse and reason over the rows directly. Use sparingly for large exports; pass an id from list_my_analytics_uploads.",
      inputSchema: z.object({
        id: z.string().describe("id from list_my_analytics_uploads"),
      }),
      execute: async ({ id }) => {
        const { data, error } = await supabase
          .from("creator_analytics_uploads")
          .select("provider, label, filename, content_type, content_text, created_at")
          .eq("id", id)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`upload ${id} not found`);
        return data;
      },
    }),
  };
}

