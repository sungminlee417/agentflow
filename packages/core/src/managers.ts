// Manager registry.
//
// A "manager" is a self-contained sub-product inside agentflow that
// bundles a domain's integrations, tools, automation types, and UI
// scope. The user opens a manager to work within that context. The
// chat is global and can use tools from any enabled manager.
//
// Adding a new manager is a registry entry + the underlying tools.
// The sidebar and per-manager dashboard are driven by this list, so
// no new UI scaffolding is needed.

export type ManagerSlug = "code" | "social";

export type Manager = {
  slug: ManagerSlug;
  label: string;
  description: string;
  /** Automation type strings that belong to this manager (e.g. "github_issue_to_pr"). */
  automationTypes: string[];
  /** Integration provider strings that belong to this manager (e.g. "github"). */
  integrationProviders: string[];
  /** "available" = built and shippable; "coming_soon" = stubbed in the registry but not implemented yet. */
  status: "available" | "coming_soon";
};

export const MANAGERS: Manager[] = [
  {
    slug: "code",
    label: "Code",
    description:
      "Watch GitHub repos for new issues, read code, and open PRs autonomously.",
    automationTypes: ["github_issue_to_pr"],
    integrationProviders: ["github"],
    status: "available",
  },
  {
    slug: "social",
    label: "Social Media",
    description:
      "Analytics, content ideas, and comment workflows across YouTube, TikTok, and Instagram.",
    automationTypes: [
      "social_brief_youtube",
      "social_brief_tiktok",
      "social_brief_instagram",
      "social_brief_cross_platform",
    ],
    integrationProviders: ["youtube", "tiktok", "instagram"],
    status: "available",
  },
];

export function getManager(slug: string): Manager | undefined {
  return MANAGERS.find((m) => m.slug === slug);
}

export function managerForAutomationType(type: string): Manager | undefined {
  return MANAGERS.find((m) => m.automationTypes.includes(type));
}

export function managerForProvider(provider: string): Manager | undefined {
  return MANAGERS.find((m) => m.integrationProviders.includes(provider));
}
