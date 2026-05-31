import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getManager } from "@agentflow/core";
import { GitHubConnect } from "@/components/github-connect";
import {
  AutomationsSection,
  type AutomationRow,
  type AutomationRunRow,
} from "@/components/automations-section";

export default async function ManagerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { slug } = await params;
  const manager = getManager(slug);
  if (!manager) notFound();

  const supabase = await createSupabaseServerClient();
  const [{ data: integrations }, { data: automations }, { data: runs }] =
    await Promise.all([
      supabase
        .from("integrations")
        .select("provider, scopes")
        .in("provider", manager.integrationProviders),
      manager.automationTypes.length > 0
        ? supabase
            .from("automations")
            .select("id, type, config, enabled, last_run_at, created_at")
            .in("type", manager.automationTypes)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      supabase
        .from("automation_runs")
        .select(
          "id, automation_id, issue_number, status, pr_url, pr_number, error, started_at, finished_at",
        )
        .order("started_at", { ascending: false })
        .limit(100),
    ]);

  // Filter runs to only this manager's automations.
  const automationIds = new Set(
    ((automations ?? []) as AutomationRow[]).map((a) => a.id),
  );
  const scopedRuns = ((runs ?? []) as AutomationRunRow[]).filter((r) =>
    automationIds.has(r.automation_id),
  );

  const integrationByProvider = new Map(
    (integrations ?? []).map((i) => [i.provider as string, i]),
  );
  const github = integrationByProvider.get("github");

  const { connected: justConnected, error: oauthError } = await searchParams;

  const isComingSoon = manager.status === "coming_soon";

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          {manager.label} Manager
        </h1>
        <p className="mt-1 text-sm text-neutral-500">{manager.description}</p>
        {isComingSoon && (
          <span className="mt-3 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Coming soon
          </span>
        )}
      </header>

      {justConnected && (
        <div className="mt-6 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          Connected {justConnected}.
        </div>
      )}
      {oauthError && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          OAuth error: {oauthError}
        </div>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          Connections
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Services this manager uses on your behalf.
        </p>

        <div className="mt-6 space-y-4">
          {manager.integrationProviders.includes("github") && (
            <GitHubConnect
              connected={!!github}
              scopes={(github?.scopes as string[] | undefined) ?? []}
            />
          )}
          {manager.integrationProviders
            .filter((p) => p !== "github")
            .map((provider) => (
              <div
                key={provider}
                className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <span className="font-medium capitalize text-neutral-700 dark:text-neutral-300">
                  {provider}
                </span>
                <span className="ml-2 text-xs">— integration coming soon</span>
              </div>
            ))}
        </div>
      </section>

      {!isComingSoon && manager.automationTypes.length > 0 && (
        <AutomationsSection
          automations={(automations ?? []) as AutomationRow[]}
          runs={scopedRuns}
          githubConnected={!!github}
        />
      )}
    </div>
  );
}
