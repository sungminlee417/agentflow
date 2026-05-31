import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ActivityFeed, type AutomationSummary, type RunRow } from "@/components/activity-feed";

export default async function ActivityPage() {
  const supabase = await createSupabaseServerClient();

  const [{ data: runs }, { data: automations }] = await Promise.all([
    supabase
      .from("automation_runs")
      .select(
        "id, automation_id, issue_number, status, pr_url, pr_number, error, summary, tokens, step_count, last_step, report_markdown, started_at, finished_at",
      )
      .order("started_at", { ascending: false })
      .limit(100),
    supabase.from("automations").select("id, type, config"),
  ]);

  return (
    <ActivityFeed
      initialRuns={(runs ?? []) as RunRow[]}
      automations={(automations ?? []) as AutomationSummary[]}
    />
  );
}
