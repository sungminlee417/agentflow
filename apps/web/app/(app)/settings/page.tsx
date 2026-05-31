import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PROVIDERS } from "@agentflow/core";
import { ApiKeyForm } from "@/components/api-key-form";
import { GitHubConnect } from "@/components/github-connect";
import {
  AutomationsSection,
  type AutomationRow,
  type AutomationRunRow,
} from "@/components/automations-section";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const [
    { data: keys },
    { data: integrations },
    { data: automations },
    { data: runs },
  ] = await Promise.all([
    supabase
      .from("user_api_keys")
      .select("provider, key_last4, model, updated_at"),
    supabase.from("integrations").select("provider, scopes"),
    supabase
      .from("automations")
      .select("id, type, config, enabled, last_run_at, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("automation_runs")
      .select(
        "id, automation_id, issue_number, status, pr_url, pr_number, error, started_at, finished_at",
      )
      .order("started_at", { ascending: false })
      .limit(100),
  ]);

  const keysByProvider = new Map(
    (keys ?? []).map((k) => [k.provider as string, k]),
  );
  const integrationByProvider = new Map(
    (integrations ?? []).map((i) => [i.provider as string, i]),
  );
  const github = integrationByProvider.get("github");

  const { connected: justConnected, error: oauthError } = await searchParams;

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
        Settings
      </h1>

      {justConnected && (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          Connected {justConnected}.
        </div>
      )}
      {oauthError && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          OAuth error: {oauthError}
        </div>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          AI provider keys
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Bring your own keys — they're encrypted at rest and used only to
          forward your messages to the provider you select.
        </p>

        <div className="mt-6 space-y-4">
          {PROVIDERS.map((p) => {
            const existing = keysByProvider.get(p.name) as
              | { key_last4: string; model: string | null }
              | undefined;
            return (
              <ApiKeyForm
                key={p.name}
                provider={p.name}
                label={p.label}
                keyHint={p.keyHint}
                existingLast4={existing?.key_last4 ?? null}
                existingModel={existing?.model ?? null}
              />
            );
          })}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          Integrations
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connect services so the agent can act on your behalf.
        </p>

        <div className="mt-6 space-y-4">
          <GitHubConnect
            connected={!!github}
            scopes={(github?.scopes as string[] | undefined) ?? []}
          />
        </div>
      </section>

      <AutomationsSection
        automations={(automations ?? []) as AutomationRow[]}
        runs={(runs ?? []) as AutomationRunRow[]}
        githubConnected={!!github}
      />
    </div>
  );
}
