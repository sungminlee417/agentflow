import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getManager } from "@agentflow/core";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const manager = getManager(slug);
  return {
    title: manager?.label ?? "Manager",
  };
}
import {
  AutomationsSection,
  type AutomationRow,
  type AutomationRunRow,
} from "@/components/automations-section";

export default async function ManagerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
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
            .select(
              "id, type, config, enabled, schedule, last_run_at, created_at",
            )
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

  const automationIds = new Set(
    ((automations ?? []) as AutomationRow[]).map((a) => a.id),
  );
  const scopedRuns = ((runs ?? []) as AutomationRunRow[]).filter((r) =>
    automationIds.has(r.automation_id),
  );

  const connectedProviders = (integrations ?? []).map(
    (i) => i.provider as string,
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:py-10">
      <header className="flex flex-wrap items-start justify-between gap-3 pl-10 md:pl-0">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {manager.label}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {manager.description}
          </p>
        </div>
        <Link
          href="/integrations"
          className="shrink-0 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          Configure →
        </Link>
      </header>

      <section className="mt-6">
        <ConnectionStatus
          providers={manager.integrationProviders}
          connected={connectedProviders}
        />
      </section>

      {manager.automationTypes.length > 0 && (
        <AutomationsSection
          automations={(automations ?? []) as AutomationRow[]}
          runs={scopedRuns}
          availableTypes={manager.automationTypes as never}
          connectedProviders={connectedProviders}
        />
      )}
    </div>
  );
}

function ConnectionStatus({
  providers,
  connected,
}: {
  providers: string[];
  connected: string[];
}) {
  if (providers.length === 0) return null;
  const anyConnected = providers.some((p) => connected.includes(p));

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
        anyConnected
          ? "border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900"
          : "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
      }`}
    >
      <span
        className={
          anyConnected
            ? "text-neutral-600 dark:text-neutral-400"
            : "text-amber-800 dark:text-amber-300"
        }
      >
        {anyConnected
          ? "Connected:"
          : "Nothing connected yet — head to Integrations to set up:"}
      </span>
      {providers.map((p) => {
        const isOn = connected.includes(p);
        return (
          <span
            key={p}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
              isOn
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
            }`}
          >
            <span
              className={`h-1 w-1 rounded-full ${
                isOn ? "bg-emerald-500" : "bg-neutral-400"
              }`}
            />
            {p}
          </span>
        );
      })}
    </div>
  );
}
