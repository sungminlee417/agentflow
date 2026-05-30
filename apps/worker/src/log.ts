import type { JobEvent } from "@agentflow/core";
import { supabase } from "./supabase.js";

export async function logEvent(
  jobId: string,
  level: JobEvent["level"],
  message: string,
): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${jobId}] [${level}] ${message}`);
  const { error } = await supabase.from("job_events").insert({
    job_id: jobId,
    level,
    message,
  });
  if (error) {
    console.error("failed to write job_event", error);
  }
}
