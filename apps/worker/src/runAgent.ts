import type {
  AgentContext,
  AgentResult,
  DomainPlugin,
  Integration,
  Job,
} from "@agentflow/core";

// TODO: wire up @anthropic-ai/claude-agent-sdk here.
// The runner should:
//   1. Build tools from plugin.buildTools(ctx)
//   2. Construct system + user prompts from plugin.build{System,User}Prompt
//   3. Run the agent loop with prompt caching enabled on system + tools
//   4. Stream events to ctx.log
//   5. Collect generated artifacts (returned by tools that write
//      "report"/"recommendations"/etc., or parsed from the final assistant
//      message)
//   6. Return tokens + cost so the worker can write them back to the job row
//
// Model defaults:
//   - kind === "ideas"  → claude-opus-4-7 (gap analysis benefits from
//     the stronger reasoning)
//   - everything else   → claude-sonnet-4-6
//
// Use the claude-api skill the next time we touch this file to make sure
// caching, model IDs, and the SDK surface are current.

export async function runAgent(
  plugin: DomainPlugin,
  job: Job,
  integration: Integration | null,
  log: AgentContext["log"],
): Promise<AgentResult> {
  await log("info", `runAgent stub: domain=${plugin.slug} kind=${job.kind}`);
  await log("warn", "agent runner not implemented yet — returning empty result");
  void integration;
  return { artifacts: [], total_tokens: 0, cost_usd: 0 };
}
