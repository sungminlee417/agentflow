import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getManager,
  getOAuthCredentials,
  type OAuthProvider,
} from "@agentflow/core";
import { OAuthConnect } from "@/components/oauth-connect";
import {
  AutomationsSection,
  type AutomationRow,
  type AutomationRunRow,
} from "@/components/automations-section";
import {
  AnalyticsUpload,
  type UploadRow,
} from "@/components/analytics-upload";
import { ServiceKeyForm } from "@/components/service-key-form";

const PROVIDER_META: Record<
  string,
  { label: string; description: string; hint?: string }
> = {
  github: {
    label: "GitHub",
    description: "Read code, manage issues, open PRs on your behalf.",
    hint:
      "Create your OAuth app at https://github.com/settings/developers — Authorization callback URL: http://localhost:3000/api/oauth/github/callback",
  },
  youtube: {
    label: "YouTube",
    description: "Read your videos, analytics, and search the platform.",
    hint:
      "Create an OAuth client at https://console.cloud.google.com → Credentials. Enable YouTube Data API v3 + Analytics API. Redirect URI: http://localhost:3000/api/oauth/youtube/callback",
  },
  tiktok: {
    label: "TikTok",
    description: "Read your videos and profile stats.",
    hint:
      "Create an app at https://developers.tiktok.com, enable Login Kit + Display API. HTTPS callback required — use ngrok for local dev. Add yourself as a Sandbox tester.",
  },
  instagram: {
    label: "Instagram",
    description: "Read your media, insights, comments. Reply to comments.",
    hint:
      "Create a Business app at https://developers.facebook.com, add Instagram product, set up Instagram Login. HTTPS callback required (ngrok). Add yourself as Developer/Admin/Tester.",
  },
};

// Per-provider upload card metadata. These appear only for social
// platforms — we use it to capture what the platforms' APIs can't give
// us directly (retention, traffic source, audience demographics).
const UPLOAD_META: Record<
  string,
  { label: string; description: string }
> = {
  tiktok: {
    label: "TikTok Studio export",
    description:
      "Drop in a CSV export from TikTok Studio (Analytics → Overview / Content → Export). This is where the retention curves, traffic sources, and watch time live — the API doesn't expose them.",
  },
  youtube: {
    label: "YouTube Studio export",
    description:
      "Optional supplement to the YouTube Analytics API. Upload Studio CSV exports if you want the agent to read deeper retention / impressions data than the API returns.",
  },
  instagram: {
    label: "Instagram Insights export",
    description:
      "Drop in CSV/JSON exports from Meta Business Suite Insights or Creator Studio if you want the agent to reason over historical reach / impressions / saves.",
  },
};

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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isSocial = manager.slug === "social";

  const [
    { data: integrations },
    { data: automations },
    { data: runs },
    { data: oauthCreds },
    { data: uploads },
    { data: serviceKeys },
  ] = await Promise.all([
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
    supabase
      .from("user_oauth_credentials")
      .select("provider, client_id_last4")
      .in("provider", manager.integrationProviders),
    isSocial
      ? supabase
          .from("creator_analytics_uploads")
          .select(
            "id, provider, label, filename, content_type, size_bytes, created_at",
          )
          .in("provider", manager.integrationProviders)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    isSocial
      ? supabase
          .from("user_service_keys")
          .select("service, key_last4, updated_at")
      : Promise.resolve({ data: [] }),
  ]);

  const credSourceByProvider = new Map<string, "user" | "env" | null>();
  if (user) {
    await Promise.all(
      manager.integrationProviders.map(async (p) => {
        const resolved = await getOAuthCredentials(
          supabase,
          user.id,
          p as OAuthProvider,
        );
        credSourceByProvider.set(p, resolved?.source ?? null);
      }),
    );
  }

  const automationIds = new Set(
    ((automations ?? []) as AutomationRow[]).map((a) => a.id),
  );
  const scopedRuns = ((runs ?? []) as AutomationRunRow[]).filter((r) =>
    automationIds.has(r.automation_id),
  );

  const integrationByProvider = new Map(
    (integrations ?? []).map((i) => [i.provider as string, i]),
  );
  const credsLast4ByProvider = new Map(
    (oauthCreds ?? []).map(
      (c) => [c.provider as string, c.client_id_last4 as string],
    ),
  );
  const uploadsByProvider = new Map<string, UploadRow[]>();
  for (const u of (uploads ?? []) as UploadRow[]) {
    const list = uploadsByProvider.get(u.provider) ?? [];
    list.push(u);
    uploadsByProvider.set(u.provider, list);
  }
  const apifyKey = (serviceKeys ?? []).find((k) => k.service === "apify");

  const github = integrationByProvider.get("github");

  const { connected: justConnected, error: oauthError } = await searchParams;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          {manager.label} Manager
        </h1>
        <p className="mt-1 text-sm text-neutral-500">{manager.description}</p>
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
          Each platform uses your own OAuth app — paste your app's credentials
          first, then click Connect to grant your account.
        </p>

        <div className="mt-6 space-y-4">
          {manager.integrationProviders.map((provider) => {
            const meta = PROVIDER_META[provider];
            if (!meta) {
              return (
                <div
                  key={provider}
                  className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <span className="font-medium capitalize text-neutral-700 dark:text-neutral-300">
                    {provider}
                  </span>
                  <span className="ml-2 text-xs">— config missing</span>
                </div>
              );
            }
            const integration = integrationByProvider.get(provider);
            const source = credSourceByProvider.get(provider) ?? null;
            return (
              <OAuthConnect
                key={provider}
                provider={provider}
                label={meta.label}
                description={meta.description}
                hint={meta.hint}
                connected={!!integration}
                scopes={(integration?.scopes as string[] | undefined) ?? []}
                credentialsConfigured={!!source}
                credentialsLast4={credsLast4ByProvider.get(provider) ?? null}
                credentialsSource={source}
              />
            );
          })}
        </div>
      </section>

      {isSocial && (
        <>
          <section className="mt-12">
            <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
              Analytics uploads
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Drop in CSV/JSON exports from each platform's creator
              dashboard. Retention curves, traffic sources, audience
              demographics — the metrics that actually predict virality and
              aren't exposed by any platform API.
            </p>

            <div className="mt-6 space-y-4">
              {manager.integrationProviders.map((provider) => {
                const meta = UPLOAD_META[provider];
                if (!meta) return null;
                return (
                  <AnalyticsUpload
                    key={provider}
                    provider={provider as "tiktok" | "youtube" | "instagram"}
                    label={meta.label}
                    description={meta.description}
                    uploads={uploadsByProvider.get(provider) ?? []}
                  />
                );
              })}
            </div>
          </section>

          <section className="mt-12">
            <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
              Trend &amp; competitor research
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Optional: connect Apify to give the agent niche-search and
              competitor-profile tools. Pay-per-call (~$0.30 / 100 results).
            </p>

            <div className="mt-6">
              <ServiceKeyForm
                service="apify"
                label="Apify"
                description="Powers TikTok hashtag/keyword search + competitor profile lookups."
                keyHint="apify_api_..."
                hint='Get a token at https://console.apify.com/account/integrations. The agent uses it to run the "clockworks/tiktok-scraper" actor.'
                existingLast4={apifyKey?.key_last4 ?? null}
              />
            </div>
          </section>
        </>
      )}

      {manager.automationTypes.length > 0 && (
        <AutomationsSection
          automations={(automations ?? []) as AutomationRow[]}
          runs={scopedRuns}
          githubConnected={!!github}
        />
      )}
    </div>
  );
}
