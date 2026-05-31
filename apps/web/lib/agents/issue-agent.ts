import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { decrypt } from "@/lib/crypto";
import { getModel, isProvider } from "@/lib/ai-providers";
import { buildToolsForUser } from "@/lib/tools";

// Autonomous agent run that processes a single GitHub issue end-to-end:
// reads the issue, explores the repo, opens a PR (or comments asking
// for clarification if the issue isn't actionable).
//
// Returns a structured result so the caller can persist it without
// inspecting tool history in the caller. The PR URL is extracted from
// the github_create_pr tool result if it was called.

const SYSTEM_PROMPT = (repo: string, issueNumber: number) =>
  `You are agentflow, running as an autonomous agent for the user. You were started by a saved automation, not by an interactive chat — so do not ask the user questions back. Make a decision and act.

Task: address GitHub issue #${issueNumber} on ${repo}.

Procedure:
1. Call github_get_issue to read the full issue including its comments. Form a clear, narrow understanding of what is being asked.
2. Use github_list_directory and github_get_file to inspect the relevant code. Do not skip this — never guess at file contents.
3. Decide on the MINIMAL change that addresses the issue.
   - If the issue is unclear, contradictory, or out of scope for a small PR, instead call github_post_issue_comment with a polite question asking for clarification and STOP. Do not open a PR you're not confident in.
   - If the issue is clearly answered without code changes (e.g. "how do I do X"), post a github_post_issue_comment answering it and STOP.
4. If you decide to make code changes:
   - Open a PR with github_create_pr. Branch name: \`agent/issue-${issueNumber}\`. PR title: "Fix #${issueNumber}: <short summary>". PR body: explain what changed and why, and end with "Closes #${issueNumber}".
   - Then call github_post_issue_comment on the issue with a link to the PR (use the URL returned by github_create_pr).

Constraints:
- Keep changes minimal. Do not refactor unrelated code.
- Do not modify files outside what's needed for the issue.
- Do not run more than necessary — be efficient with tool calls.
- Always reference exact file paths and line numbers when describing changes in the PR body.`;

export type IssueAgentResult = {
  ok: boolean;
  pr_url?: string;
  pr_number?: number;
  summary?: string;
  tokens?: number;
  error?: string;
};

function extractPrFromMessages(messages: unknown): {
  pr_url?: string;
  pr_number?: number;
} {
  if (!Array.isArray(messages)) return {};
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = (m as Record<string, unknown>).role;
    if (role !== "tool") continue;
    const content = (m as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const isToolResult =
        p.type === "tool-result" || p.type === "tool_result";
      if (!isToolResult) continue;
      const toolName = String(p.toolName ?? p.name ?? "");
      if (toolName !== "github_create_pr") continue;
      const output =
        (p.output as Record<string, unknown> | undefined) ??
        (p.result as Record<string, unknown> | undefined);
      if (!output || typeof output !== "object") continue;
      return {
        pr_url:
          typeof output.url === "string" ? output.url : undefined,
        pr_number:
          typeof output.number === "number" ? output.number : undefined,
      };
    }
  }
  return {};
}

export async function runIssueAgent({
  supabase,
  userId,
  repo,
  issueNumber,
}: {
  supabase: SupabaseClient;
  userId: string;
  repo: string;
  issueNumber: number;
}): Promise<IssueAgentResult> {
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, encrypted_key")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (!keys || keys.length === 0) {
    return { ok: false, error: "No AI provider key configured." };
  }
  const { provider, encrypted_key } = keys[0]!;
  if (!isProvider(provider)) {
    return { ok: false, error: `Unknown provider: ${provider}` };
  }

  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch (err) {
    return {
      ok: false,
      error: `Could not decrypt API key: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  const { tools, connected } = await buildToolsForUser(supabase, userId);
  if (!connected.includes("github")) {
    return { ok: false, error: "GitHub integration not connected." };
  }

  try {
    const result = await generateText({
      model: getModel(provider, apiKey),
      system: SYSTEM_PROMPT(repo, issueNumber),
      messages: [
        {
          role: "user",
          content: `Please address issue #${issueNumber} in ${repo}.`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      stopWhen: stepCountIs(20),
    });

    const { pr_url, pr_number } = extractPrFromMessages(
      result.response.messages,
    );
    return {
      ok: true,
      pr_url,
      pr_number,
      summary: result.text || undefined,
      tokens: result.usage?.totalTokens ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
