// Catalog of all automation types — used by the UI to render the
// "create automation" form and by the worker to dispatch to the
// correct agent runner.

export type AutomationKind =
  | "github_issue_to_pr"
  | SocialBriefKind
  | SocialScriptsKind;

export type SocialBriefKind =
  | "social_brief_youtube"
  | "social_brief_tiktok"
  | "social_brief_instagram"
  | "social_brief_cross_platform";

export type SocialScriptsKind =
  | "social_scripts_youtube"
  | "social_scripts_tiktok"
  | "social_scripts_instagram";

export type AutomationSchedule = "manual" | "daily" | "weekly";

export const SCHEDULE_OPTIONS: AutomationSchedule[] = [
  "manual",
  "daily",
  "weekly",
];

export type AutomationTypeMeta = {
  type: AutomationKind;
  label: string;
  description: string;
  defaultSchedule: AutomationSchedule;
  /** providers this automation needs the user to have connected */
  requires: string[];
  configFields: Array<
    | { name: "repo"; label: string; placeholder: string }
    | { name: "focus"; label: string; placeholder: string }
  >;
};

export const AUTOMATION_TYPES: AutomationTypeMeta[] = [
  {
    type: "github_issue_to_pr",
    label: "GitHub: issue → PR",
    description:
      "Watches the repo for open issues and opens a PR per issue, with status updates on the project board.",
    defaultSchedule: "manual",
    requires: ["github"],
    configFields: [
      {
        name: "repo",
        label: "Repo",
        placeholder: "owner/name (e.g. sungminlee417/agentflow)",
      },
    ],
  },
  {
    type: "social_brief_youtube",
    label: "YouTube: weekly content brief",
    description:
      "Analyzes recent videos + analytics + trending niche search, produces a markdown brief with what's working, what to make next, and example titles/hooks.",
    defaultSchedule: "weekly",
    requires: ["youtube"],
    configFields: [
      {
        name: "focus",
        label: "Focus / niche (optional)",
        placeholder: "e.g. AI productivity tutorials",
      },
    ],
  },
  {
    type: "social_brief_tiktok",
    label: "TikTok: weekly content brief",
    description:
      "Analyzes recent videos, uploaded Studio exports, and (if Apify connected) trending niche content. Produces video concepts ranked by likelihood of going viral.",
    defaultSchedule: "weekly",
    requires: ["tiktok"],
    configFields: [
      {
        name: "focus",
        label: "Focus / niche (optional)",
        placeholder: "e.g. desk setups for designers",
      },
    ],
  },
  {
    type: "social_brief_instagram",
    label: "Instagram: weekly content brief",
    description:
      "Analyzes recent posts + insights + comment sentiment. Produces post concepts, caption directions, and themes worth testing.",
    defaultSchedule: "weekly",
    requires: ["instagram"],
    configFields: [
      {
        name: "focus",
        label: "Focus / niche (optional)",
        placeholder: "e.g. interior design for renters",
      },
    ],
  },
  {
    type: "social_brief_cross_platform",
    label: "Cross-platform growth brief",
    description:
      "Pulls from all connected social platforms, looks for content that crossed over well, and recommends what to make next for maximum reach.",
    defaultSchedule: "weekly",
    requires: [],
    configFields: [],
  },
  {
    type: "social_scripts_youtube",
    label: "YouTube: next-video scripts",
    description:
      "Reads your channel + niche trends and outputs 3-5 ready-to-record scripts for your next videos, each with hook, beats, CTA, hashtags, and visual notes.",
    defaultSchedule: "weekly",
    requires: ["youtube"],
    configFields: [
      {
        name: "focus",
        label: "Niche / channel theme (optional)",
        placeholder: "e.g. AI productivity tutorials for solo founders",
      },
    ],
  },
  {
    type: "social_scripts_tiktok",
    label: "TikTok: next-video scripts",
    description:
      "Reads your TikTok + niche trends and outputs 3-5 ready-to-record short-form scripts, each with hook (0-3s), beats, CTA, hashtags, and visual notes.",
    defaultSchedule: "weekly",
    requires: ["tiktok"],
    configFields: [
      {
        name: "focus",
        label: "Niche / channel theme (optional)",
        placeholder: "e.g. minimalist desk setups for remote workers",
      },
    ],
  },
  {
    type: "social_scripts_instagram",
    label: "Instagram: next-post scripts",
    description:
      "Reads your Instagram + audience signal and outputs 3-5 post concepts (Reels / Carousels / single) with full script + caption + hashtags.",
    defaultSchedule: "weekly",
    requires: ["instagram"],
    configFields: [
      {
        name: "focus",
        label: "Niche / channel theme (optional)",
        placeholder: "e.g. interior design for renters",
      },
    ],
  },
];

export function getAutomationTypeMeta(
  type: string,
): AutomationTypeMeta | undefined {
  return AUTOMATION_TYPES.find((m) => m.type === type);
}

export function isSocialBrief(type: string): type is SocialBriefKind {
  return type.startsWith("social_brief_");
}

export function isSocialScripts(type: string): type is SocialScriptsKind {
  return type.startsWith("social_scripts_");
}

export function platformForSocialBrief(
  type: SocialBriefKind,
): "youtube" | "tiktok" | "instagram" | "cross" {
  switch (type) {
    case "social_brief_youtube":
      return "youtube";
    case "social_brief_tiktok":
      return "tiktok";
    case "social_brief_instagram":
      return "instagram";
    case "social_brief_cross_platform":
      return "cross";
  }
}

export function platformForSocialScripts(
  type: SocialScriptsKind,
): "youtube" | "tiktok" | "instagram" {
  switch (type) {
    case "social_scripts_youtube":
      return "youtube";
    case "social_scripts_tiktok":
      return "tiktok";
    case "social_scripts_instagram":
      return "instagram";
  }
}
