import type { Job } from "@agentflow/core";
import { supabase } from "./supabase.js";

export async function claimNextJob(): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_next_job");
  if (error) {
    console.error("claim_next_job failed", error);
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Job;
}

export async function finishJob(
  jobId: string,
  patch: Partial<
    Pick<Job, "status" | "error" | "finished_at" | "total_tokens" | "cost_usd">
  >,
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      ...patch,
      finished_at: patch.finished_at ?? new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) console.error("finishJob failed", error);
}
