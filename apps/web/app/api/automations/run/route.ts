import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, runIssueAgent } from "@agentflow/core";

// Manual "Run now" trigger for the user's enabled automations.
//
// github_issue_to_pr is the only automation type today. It processes
// one outstanding open issue per automation per call (bounded for
// Vercel's serverless time budget).

export const maxDuration = 60;

type RunReport = {
  automation_id: string;
  status: "ok" | "skipped" | "failed";
  message: string;
  meta?: Record<string, unknown>;
};

export async function POST(_request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data: automations, error: aErr } = await supabase
    .from("automations")
    .select("id, type, config")
    .eq("user_id", user.id)
    .eq("enabled", true);
  if (aErr) return new NextResponse(aErr.message, { status: 500 });
  if (!automations || automations.length === 0) {
    return NextResponse.json({
      reports: [],
      message: "No enabled automations.",
    });
  }

  const reports: RunReport[] = [];

  for (const automation of automations) {
    if (automation.type === "github_issue_to_pr") {
      reports.push(await runIssueAutomation(supabase, user.id, automation));
    } else {
      reports.push({
        automation_id: automation.id,
        status: "skipped",
        message: `Unsupported type: ${automation.type}`,
      });
    }
  }

  return NextResponse.json({ reports });
}

async function runIssueAutomation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  automation: { id: string; type: string; config: Record<string, unknown> },
): Promise<RunReport> {
  const repo = (automation.config as { repo?: string } | null)?.repo;
  if (!repo) {
    return {
      automation_id: automation.id,
      status: "skipped",
      message: "Missing config.repo",
    };
  }

  const { data: ghRow } = await supabase
    .from("integrations")
    .select("encrypted_access_token")
    .eq("user_id", userId)
    .eq("provider", "github")
    .maybeSingle();
  if (!ghRow?.encrypted_access_token) {
    return {
      automation_id: automation.id,
      status: "failed",
      message: "GitHub is not connected — connect it before running.",
    };
  }
  let ghToken: string;
  try {
    ghToken = decrypt(ghRow.encrypted_access_token);
  } catch (err) {
    return {
      automation_id: automation.id,
      status: "failed",
      message: `Failed to decrypt GitHub token: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  let issues: Array<{ number: number; pull_request?: unknown }>;
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
    if (!res.ok) {
      throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    issues = (await res.json()) as typeof issues;
  } catch (err) {
    return {
      automation_id: automation.id,
      status: "failed",
      message: `Failed to list issues: ${err instanceof Error ? err.message : "unknown"}`,
      meta: { repo },
    };
  }

  const realIssues = issues.filter((i) => !i.pull_request);
  if (realIssues.length === 0) {
    return {
      automation_id: automation.id,
      status: "skipped",
      message: "No open issues in this repo.",
      meta: { repo },
    };
  }

  const { data: existingRuns } = await supabase
    .from("automation_runs")
    .select("issue_number")
    .eq("automation_id", automation.id);
  const handled = new Set(
    (existingRuns ?? [])
      .map((r: { issue_number: number | null }) => r.issue_number)
      .filter((n: number | null): n is number => n !== null),
  );
  const next = realIssues.find((i) => !handled.has(i.number));
  if (!next) {
    return {
      automation_id: automation.id,
      status: "skipped",
      message: "All open issues have already been handled.",
      meta: { repo },
    };
  }

  const { data: run, error: runErr } = await supabase
    .from("automation_runs")
    .insert({
      automation_id: automation.id,
      user_id: userId,
      issue_number: next.number,
      status: "running",
    })
    .select("id")
    .single();
  if (runErr || !run) {
    return {
      automation_id: automation.id,
      status: "failed",
      message: `Could not record run: ${runErr?.message ?? "unknown"}`,
    };
  }

  const result = await runIssueAgent({
    supabase,
    userId,
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

  return {
    automation_id: automation.id,
    status: result.ok ? "ok" : "failed",
    message: result.ok
      ? result.pr_url
        ? `Opened ${result.pr_url} for issue #${next.number}.`
        : `Handled issue #${next.number} (no PR — likely commented for clarification).`
      : `Failed on issue #${next.number}: ${result.error ?? "unknown error"}`,
    meta: { repo, issue_number: next.number, pr_url: result.pr_url },
  };
}
