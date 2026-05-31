import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, runIssueAgent } from "@agentflow/core";

// Process new issues for the user's enabled automations.
//
// Phase C is synchronous: each click runs at most ONE outstanding
// issue per automation, so we stay within Vercel's serverless time
// budget and the user gets clear "I did X" feedback. Click again to
// process the next one.
//
// Dedup is via automation_runs: we skip issues that have any 'done'
// row for the same automation. 'failed' rows can be retried.

export const maxDuration = 60; // seconds — Vercel hobby limit

type RunReport = {
  automation_id: string;
  repo?: string;
  status: "ok" | "skipped" | "failed";
  message: string;
  issue_number?: number;
  pr_url?: string;
};

export async function POST(request: NextRequest) {
  void request;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  // Load enabled automations.
  const { data: automations, error: aErr } = await supabase
    .from("automations")
    .select("id, type, config")
    .eq("user_id", user.id)
    .eq("enabled", true);
  if (aErr) return new NextResponse(aErr.message, { status: 500 });
  if (!automations || automations.length === 0) {
    return NextResponse.json({ reports: [], message: "No enabled automations." });
  }

  // Resolve GitHub token once for issue-list fetches.
  const { data: ghRow } = await supabase
    .from("integrations")
    .select("encrypted_access_token")
    .eq("user_id", user.id)
    .eq("provider", "github")
    .maybeSingle();
  if (!ghRow?.encrypted_access_token) {
    return new NextResponse(
      "GitHub is not connected — connect it in Settings before running automations.",
      { status: 400 },
    );
  }
  let ghToken: string;
  try {
    ghToken = decrypt(ghRow.encrypted_access_token);
  } catch (err) {
    return new NextResponse(
      `Failed to decrypt GitHub token: ${err instanceof Error ? err.message : "unknown"}`,
      { status: 500 },
    );
  }

  const reports: RunReport[] = [];

  for (const automation of automations) {
    if (automation.type !== "github_issue_to_pr") {
      reports.push({
        automation_id: automation.id,
        status: "skipped",
        message: `Unsupported type: ${automation.type}`,
      });
      continue;
    }
    const repo = (automation.config as { repo?: string } | null)?.repo;
    if (!repo) {
      reports.push({
        automation_id: automation.id,
        status: "skipped",
        message: "Automation is missing config.repo",
      });
      continue;
    }

    // Fetch open issues. Filter out PRs and the ones we've already done.
    let issues: Array<{ number: number; pull_request?: unknown }> = [];
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues?state=open&per_page=50&sort=created&direction=asc`,
        {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "agentflow",
          },
        },
      );
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
      issues = (await res.json()) as typeof issues;
    } catch (err) {
      reports.push({
        automation_id: automation.id,
        repo,
        status: "failed",
        message: `Failed to list issues: ${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }

    const realIssues = issues.filter((i) => !i.pull_request);
    if (realIssues.length === 0) {
      reports.push({
        automation_id: automation.id,
        repo,
        status: "skipped",
        message: "No open issues in this repo.",
      });
      continue;
    }

    // Find the oldest open issue with no successful run for this automation.
    const { data: doneRuns } = await supabase
      .from("automation_runs")
      .select("issue_number")
      .eq("automation_id", automation.id)
      .eq("status", "done");
    const handled = new Set((doneRuns ?? []).map((r) => r.issue_number));

    const next = realIssues.find((i) => !handled.has(i.number));
    if (!next) {
      reports.push({
        automation_id: automation.id,
        repo,
        status: "skipped",
        message: "All open issues have already been handled.",
      });
      continue;
    }

    // Insert a 'running' row, run the agent, then update the row.
    const { data: run, error: runErr } = await supabase
      .from("automation_runs")
      .insert({
        automation_id: automation.id,
        user_id: user.id,
        issue_number: next.number,
        status: "running",
      })
      .select("id")
      .single();
    if (runErr || !run) {
      reports.push({
        automation_id: automation.id,
        repo,
        status: "failed",
        message: `Could not record run: ${runErr?.message ?? "unknown"}`,
      });
      continue;
    }

    const result = await runIssueAgent({
      supabase,
      userId: user.id,
      repo,
      issueNumber: next.number,
      onStep: async ({ count, description }) => {
        await supabase
          .from("automation_runs")
          .update({ step_count: count, last_step: description })
          .eq("id", run.id);
      },
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
      .eq("id", automation.id);

    reports.push({
      automation_id: automation.id,
      repo,
      status: result.ok ? "ok" : "failed",
      issue_number: next.number,
      pr_url: result.pr_url,
      message: result.ok
        ? result.pr_url
          ? `Opened ${result.pr_url} for issue #${next.number}.`
          : `Handled issue #${next.number} (no PR — likely commented for clarification).`
        : `Failed on issue #${next.number}: ${result.error ?? "unknown error"}`,
    });
  }

  return NextResponse.json({ reports });
}
