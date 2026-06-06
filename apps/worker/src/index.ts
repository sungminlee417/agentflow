import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  decrypt,
  runIdeaSynthesis,
  runIssueAgent,
  runPostReview,
  runVideoReview,
  saveIdeaSynthesis,
  savePostReview,
  saveReview,
} from "@agentflow/core";

// Worker entry point.
//
// Polls all enabled automations across all users and dispatches to the
// appropriate runner based on automation type. Uses the Supabase
// service role to bypass RLS — we're a trusted backend with the master
// encryption key and the user's encrypted credentials.
//
// Currently only github_issue_to_pr lives here. Social-media surfaces
// (briefs + scripts) moved into Video Ideas (the live list) + Chat
// (for one-off briefs) and are no longer scheduled.

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

async function processIssueAutomation(a: Automation): Promise<void> {
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

  const { data: existingRuns } = await supabase
    .from("automation_runs")
    .select("issue_number")
    .eq("automation_id", a.id);
  const handled = new Set(
    (existingRuns ?? [])
      .map((r) => r.issue_number)
      .filter((n): n is number => n !== null),
  );
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

async function processAutomation(a: Automation): Promise<void> {
  if (a.type === "github_issue_to_pr") {
    return processIssueAutomation(a);
  }
  console.warn(`[worker] unknown automation type: ${a.type}`);
}

// Video performance reviews — for any idea whose next_review_at has
// passed, pull the actual stats + write the post-mortem. The review
// agent itself decides whether to schedule another review (it does
// for the +48h pass, stops after +7d).
async function processDueReviews(): Promise<void> {
  // Two queues to drain on each tick:
  //   1. New per-platform post reviews (video_idea_posts) — the
  //      primary path post-multi-platform migration.
  //   2. Legacy single-post reviews (video_ideas) — still polled so
  //      ideas that pre-date the migration or were linked via the
  //      legacy code path get reviewed.
  await Promise.all([processDuePostReviews(), processDueLegacyReviews()]);
}

async function processDuePostReviews(): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("video_idea_posts")
    .select("id, user_id, platform, idea_id")
    .not("next_review_at", "is", null)
    .lt("next_review_at", nowIso)
    .limit(20);
  if (error) {
    console.error(`[worker] load due post reviews failed:`, error);
    return;
  }
  if (!due || due.length === 0) return;

  // Each per-post review that succeeds queues the parent idea for a
  // cross-platform synthesis pass. De-duped by (user_id, idea_id) so
  // an idea with three posts reviewed in the same tick only triggers
  // one synthesis call.
  const synthesisQueue = new Map<string, { userId: string; ideaId: string }>();

  for (let i = 0; i < due.length; i += MAX_CONCURRENT_PER_TICK) {
    const batch = due.slice(i, i + MAX_CONCURRENT_PER_TICK);
    await Promise.all(
      batch.map(async (row) => {
        const userId = row.user_id as string;
        const postId = row.id as string;
        const platform = row.platform as string;
        const ideaId = row.idea_id as string;
        try {
          console.log(
            `[worker] reviewing ${platform} post ${postId} for user ${userId}`,
          );
          const result = await runPostReview({
            supabase,
            userId,
            postId,
          });
          if (!result.ok) {
            console.warn(
              `[worker] post review ${postId} failed: ${result.error}; backing off 24h`,
            );
            await supabase
              .from("video_idea_posts")
              .update({
                next_review_at: new Date(
                  Date.now() + 24 * 60 * 60 * 1000,
                ).toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("user_id", userId)
              .eq("id", postId);
            return;
          }
          const saved = await savePostReview(
            supabase,
            userId,
            postId,
            result,
          );
          if (!saved.ok) {
            console.error(
              `[worker] savePostReview ${postId} failed:`,
              saved.error,
            );
          } else {
            console.log(
              `[worker] reviewed ${platform} post ${postId} → verdict=${result.verdict} ratio=${result.stats?.ratio.toFixed(2)}`,
            );
            // Only synth-queue if the verdict actually settled —
            // too_early posts don't yet contribute to the cross-
            // platform story.
            if (result.verdict && result.verdict !== "too_early") {
              synthesisQueue.set(`${userId}:${ideaId}`, { userId, ideaId });
            }
          }
        } catch (err) {
          console.error(`[worker] post review ${postId} crashed:`, err);
        }
      }),
    );
  }

  // Cross-platform syntheses for every parent idea that had at least
  // one settled per-post review this tick. runIdeaSynthesis quietly
  // no-ops on ideas with fewer than 2 settled posts.
  if (synthesisQueue.size > 0) {
    const tasks = Array.from(synthesisQueue.values());
    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_PER_TICK) {
      const batch = tasks.slice(i, i + MAX_CONCURRENT_PER_TICK);
      await Promise.all(
        batch.map(async ({ userId, ideaId }) => {
          try {
            const synth = await runIdeaSynthesis({ supabase, userId, ideaId });
            if (!synth.ok) {
              // "Need 2+ settled posts" is expected, not an error worth
              // logging at warn level — common case for single-post ideas.
              if (synth.error && !/Need 2\+/.test(synth.error)) {
                console.warn(
                  `[worker] synthesis ${ideaId} skipped: ${synth.error}`,
                );
              }
              return;
            }
            const saved = await saveIdeaSynthesis(
              supabase,
              userId,
              ideaId,
              synth,
            );
            if (!saved.ok) {
              console.error(
                `[worker] saveIdeaSynthesis ${ideaId} failed:`,
                saved.error,
              );
            } else {
              console.log(
                `[worker] synthesised idea ${ideaId} → ${synth.verdict} across ${synth.posts?.length} platforms`,
              );
            }
          } catch (err) {
            console.error(`[worker] synthesis ${ideaId} crashed:`, err);
          }
        }),
      );
    }
  }
}

async function processDueLegacyReviews(): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("video_ideas")
    .select("id, user_id")
    .eq("status", "done")
    .not("posted_video_id", "is", null)
    .not("next_review_at", "is", null)
    .lt("next_review_at", nowIso)
    .limit(20);
  if (error) {
    console.error(`[worker] load due legacy reviews failed:`, error);
    return;
  }
  if (!due || due.length === 0) return;

  for (let i = 0; i < due.length; i += MAX_CONCURRENT_PER_TICK) {
    const batch = due.slice(i, i + MAX_CONCURRENT_PER_TICK);
    await Promise.all(
      batch.map(async (row) => {
        const userId = row.user_id as string;
        const ideaId = row.id as string;
        try {
          console.log(
            `[worker] reviewing legacy idea ${ideaId} for user ${userId}`,
          );
          const result = await runVideoReview({
            supabase,
            userId,
            ideaId,
          });
          if (!result.ok) {
            console.warn(
              `[worker] legacy review ${ideaId} failed: ${result.error}; backing off 24h`,
            );
            await supabase
              .from("video_ideas")
              .update({
                next_review_at: new Date(
                  Date.now() + 24 * 60 * 60 * 1000,
                ).toISOString(),
              })
              .eq("user_id", userId)
              .eq("id", ideaId);
            return;
          }
          const saved = await saveReview(supabase, userId, ideaId, result);
          if (!saved.ok) {
            console.error(
              `[worker] saveReview ${ideaId} failed:`,
              saved.error,
            );
          } else {
            console.log(
              `[worker] reviewed legacy ${ideaId} → verdict=${result.verdict} ratio=${result.stats?.ratio.toFixed(2)}`,
            );
          }
        } catch (err) {
          console.error(`[worker] legacy review ${ideaId} crashed:`, err);
        }
      }),
    );
  }
}

async function tick(): Promise<void> {
  // Two independent workloads: github automations + due video reviews.
  // Both swallow their own errors so one bad row doesn't stall the
  // other.
  await Promise.all([tickAutomations(), processDueReviews()]);
}

async function tickAutomations(): Promise<void> {
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
