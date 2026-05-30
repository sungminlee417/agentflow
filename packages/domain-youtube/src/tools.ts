import type { AgentContext, AgentTool } from "@agentflow/core";

// Tool implementations are stubs for now. Each one will call the YouTube
// Data API v3 or Analytics API using the access_token from ctx.integration.
// Stubs return a clear "not implemented" payload so the agent can recover
// gracefully during early development.

function stub(name: string): AgentTool["handler"] {
  return async (input) => ({
    error: `${name} not implemented yet`,
    received_input: input,
  });
}

export function buildYouTubeTools(ctx: AgentContext): AgentTool[] {
  void ctx;
  return [
    {
      name: "list_my_videos",
      description:
        "List the authenticated channel's uploads. Returns up to `limit` videos sorted by `order` (date | views).",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          order: { type: "string", enum: ["date", "views"], default: "date" },
        },
      },
      handler: stub("list_my_videos"),
    },
    {
      name: "get_video_stats",
      description:
        "Public statistics for one video: views, likes, comments, duration, published date, tags, description, thumbnail URL.",
      input_schema: {
        type: "object",
        required: ["video_id"],
        properties: { video_id: { type: "string" } },
      },
      handler: stub("get_video_stats"),
    },
    {
      name: "get_analytics",
      description:
        "Private analytics for a video (CTR, average view duration, retention curve points, traffic sources). Requires OAuth scope.",
      input_schema: {
        type: "object",
        required: ["video_id"],
        properties: {
          video_id: { type: "string" },
          metrics: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "ctr",
                "avg_view_duration",
                "retention",
                "traffic_sources",
              ],
            },
          },
        },
      },
      handler: stub("get_analytics"),
    },
    {
      name: "get_transcript",
      description: "Plain-text transcript of a video, if captions are available.",
      input_schema: {
        type: "object",
        required: ["video_id"],
        properties: { video_id: { type: "string" } },
      },
      handler: stub("get_transcript"),
    },
    {
      name: "search_niche",
      description:
        "Search YouTube for recent videos matching a query. Use this to find what's trending in the creator's niche.",
      input_schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          published_after_days: { type: "integer", default: 30 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      },
      handler: stub("search_niche"),
    },
  ];
}
