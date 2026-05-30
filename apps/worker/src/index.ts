import "dotenv/config";
import { getDomain, registerDomain } from "@agentflow/core";
import { youtubeDomain } from "@agentflow/domain-youtube";
import { claimNextJob, finishJob } from "./claimJob.js";
import { logEvent } from "./log.js";
import { runAgent } from "./runAgent.js";
import { supabase } from "./supabase.js";

registerDomain(youtubeDomain);

const POLL_INTERVAL_MS = 2_000;

async function processOne(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;

  await logEvent(job.id, "info", `claimed job kind=${job.kind} domain=${job.domain}`);

  try {
    const plugin = getDomain(job.domain);

    const { data: integration } = await supabase
      .from("integrations")
      .select("*")
      .eq("user_id", job.user_id)
      .eq("domain", job.domain)
      .maybeSingle();

    const result = await runAgent(plugin, job, integration ?? null, (level, message) =>
      logEvent(job.id, level, message),
    );

    for (const artifact of result.artifacts) {
      await supabase.from("artifacts").insert({
        job_id: job.id,
        kind: artifact.kind,
        content_json: artifact.content_json,
        content_md: artifact.content_md,
      });
    }

    await finishJob(job.id, {
      status: "done",
      total_tokens: result.total_tokens ?? null,
      cost_usd: result.cost_usd ?? null,
    });
    await logEvent(job.id, "info", "job done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(job.id, "error", `job failed: ${message}`);
    await finishJob(job.id, { status: "failed", error: message });
  }
  return true;
}

async function loop(): Promise<void> {
  console.log("worker started");
  while (true) {
    const handled = await processOne();
    if (!handled) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop().catch((err) => {
  console.error("worker crashed", err);
  process.exit(1);
});
