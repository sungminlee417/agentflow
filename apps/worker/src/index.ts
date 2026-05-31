import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { decrypt, runIssueAgent } from "@agentflow/core";

// Worker entry point.
//
// Polls all enabled automations across all users, processes any new
// issues found on watched repos. Uses the Supabase service role to
// bypass RLS — we're a trusted backend with the master encryption key
// and the user's encrypted credentials.
//
// One issue is processed per (automation, tick). The next tick picks
// up the next issue. This keeps individual agent runs short and bounded.

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const MAX_CONCURRENT_PER_TICK = 5;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error(
    "Worker requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars",
  );
}
if (!process.env.AGENTFLOW_SECRET_KEY) {
  throw new Error(
    "Worker requires AGENTFLOW_SECRET_KEY (same value as the web app, for decrypting stored credentials)",
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

type Automation = {
  id: string;
  user_id: string;
  type: string;
  config: { repo?: string } & Record<string, unknown>;
};

async function loadGitHubToken(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("integrations")
    .select("encrypted_access_token")
    .eq("user_id", userId)
    .eq("provider", "github")
    .maybeSingle();
  if (!data?.encrypted_access_token) return null;
  try {
    return decrypt(data.encrypted_access_token);
  } catch (err) {
    console.error(`[worker] decrypt github token for ${userId} failed:`, err);
    return null;
  }
}

async function listOpenIssues(
  repo: string,
  token: string,
): Promise<Array<{ number: number; pull_request?: unknown }>> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=50&sort=created&direction=asc`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentflow-worker",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as Array<{
    number: number;
    pull_request?: unknown;
  }>;
}

async function processAutomation(a: Automation): Promise<void> {
  if (a.type !== "github_issue_to_pr") return;
  const repo = a.config.repo;
  if (!repo) {
    console.warn(`[worker] automation ${a.id} missing config.repo`);
    return;
  }

  const token = await loadGitHubToken(a.user_id);
  if (!token) {
    console.warn(
      `[worker] automation ${a.id}: user has no GitHub integration; skipping`,
    );
    return;
  }

  let issues: Array<{ number: number; pull_request?: unknown }>;
  try {
    issues = await listOpenIssues(repo, token);
  } catch (err) {
    console.error(`[worker] automation ${a.id} list_issues failed:`, err);
    return;
  }
  const realIssues = issues.filter((i) => !i.pull_request);
  if (realIssues.length === 0) return;

  const { data: doneRuns } = await supabase
    .from("automation_runs")
    .select("issue_number")
    .eq("automation_id", a.id)
    .eq("status", "done");
  const handled = new Set((doneRuns ?? []).map((r) => r.issue_number));
  const next = realIssues.find((i) => !handled.has(i.number));
  if (!next) return;

  console.log(
    `[worker] automation ${a.id} (${repo}) → processing issue #${next.number}`,
  );

  const { data: run, error: runErr } = await supabase
    .from("automation_runs")
    .insert({
      automation_id: a.id,
      user_id: a.user_id,
      issue_number: next.number,
      status: "running",
    })
    .select("id")
    .single();
  if (runErr || !run) {
    console.error(`[worker] failed to record run:`, runErr);
    return;
  }

  const result = await runIssueAgent({
    supabase,
    userId: a.user_id,
    repo,
    issueNumber: next.number,
  });

  await supabase
    .from("automation_runs")
    .update({
      status: result.ok ? "done" : "failed",
      pr_url: result.pr_url ?? null,
      pr_number: result.pr_number ?? null,
      tokens: result.tokens ?? null,
      error: result.error ?? null,
      summary: result.summary?.slice(0, 1000) ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  await supabase
    .from("automations")
    .update({ last_run_at: new Date().toISOString() })
    .eq("id", a.id);

  console.log(
    `[worker] automation ${a.id} done: ${
      result.ok
        ? result.pr_url
          ? `opened ${result.pr_url}`
          : `no PR (likely a clarification comment)`
        : `failed: ${result.error}`
    }`,
  );
}

async function tick(): Promise<void> {
  const { data: automations, error } = await supabase
    .from("automations")
    .select("id, user_id, type, config")
    .eq("enabled", true);
  if (error) {
    console.error(`[worker] load automations failed:`, error);
    return;
  }
  if (!automations || automations.length === 0) return;

  for (let i = 0; i < automations.length; i += MAX_CONCURRENT_PER_TICK) {
    const batch = automations.slice(i, i + MAX_CONCURRENT_PER_TICK);
    await Promise.all(batch.map((a) => processAutomation(a as Automation)));
  }
}

async function main(): Promise<void> {
  console.log(
    `[worker] started · polling every ${Math.round(POLL_INTERVAL_MS / 1000)}s`,
  );
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error(`[worker] tick failed:`, err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[worker] crashed:", err);
  process.exit(1);
});
