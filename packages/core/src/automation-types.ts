// Catalog of all automation types — used by the UI to render the
// "create automation" form and by the worker to dispatch to the
// correct agent runner.
//
// Currently only one type lives here. Social-media surfaces (briefs +
// scripts) were retired in favor of Video Ideas (the live list) +
// Chat (for one-off briefs). github_issue_to_pr is the remaining
// scheduled automation.

export type AutomationKind = "github_issue_to_pr";

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
  configFields: Array<{
    name: "repo";
    label: string;
    placeholder: string;
  }>;
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
];

export function getAutomationTypeMeta(
  type: string,
): AutomationTypeMeta | undefined {
  return AUTOMATION_TYPES.find((m) => m.type === type);
}
