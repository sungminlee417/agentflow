import type { DomainPlugin } from "@agentflow/core";
import { systemPromptFor, userPromptFor } from "./prompts.js";
import { buildYouTubeTools } from "./tools.js";

export const youtubeDomain: DomainPlugin = {
  slug: "youtube",
  displayName: "YouTube",
  jobKinds: [
    {
      kind: "diagnostic",
      label: "Diagnostic report",
      description: "Compare top vs. recent videos and surface patterns.",
    },
    {
      kind: "recommendations",
      label: "Concrete recommendations",
      description:
        "Pick one underperforming video and rewrite the title, thumbnail, and hook.",
    },
    {
      kind: "ideas",
      label: "New content ideas",
      description: "Gap-analyze the niche and produce 10 idea briefs.",
    },
    {
      kind: "monitor",
      label: "Weekly monitor",
      description: "Flag over/under-performers and niche shifts.",
    },
  ],
  buildTools: buildYouTubeTools,
  buildSystemPrompt: (kind) => systemPromptFor(kind),
  buildUserPrompt: (kind, input) => userPromptFor(kind, input),
};

export { systemPromptFor, userPromptFor, buildYouTubeTools };
