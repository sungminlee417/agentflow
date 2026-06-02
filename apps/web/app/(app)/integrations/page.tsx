import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getOAuthCredentials,
  type OAuthProvider,
} from "@agentflow/core";
import {
  IntegrationsHub,
  type IntegrationAddon,
  type ProviderGroup,
  type ConnectedAccount,
} from "@/components/integrations-hub";
import { type UploadRow } from "@/components/analytics-upload";

const OAUTH_PROVIDERS: Array<{
  provider: OAuthProvider;
  label: string;
  group: "code" | "social";
  description: string;
  hint?: string;
  uploadHint?: { label: string; description: string };
}> = [
  {
    provider: "github",
    label: "GitHub",
    group: "code",
    description:
      "Read code, manage issues, open PRs on your behalf. Used by the Code Manager.",
    hint:
      "Create your OAuth app at https://github.com/settings/developers — Authorization callback URL: http://localhost:3000/api/oauth/github/callback",
  },
  {
    provider: "youtube",
    label: "YouTube",
    group: "social",
    description:
      "Read your videos, analytics, and search the platform. Used by the Social Media Manager.",
    hint:
      "Create an OAuth client at https://console.cloud.google.com → Credentials. Enable YouTube Data API v3 + Analytics API. Redirect URI: http://localhost:3000/api/oauth/youtube/callback",
    uploadHint: {
      label: "YouTube Studio export",
      description:
        "Optional CSV exports from Studio for deeper retention/impressions history.",
    },
  },
  {
    provider: "tiktok",
    label: "TikTok",
    group: "social",
    description:
      "Read your videos and profile stats. Used by the Social Media Manager.",
    hint:
      "Create an app at https://developers.tiktok.com, enable Login Kit + Display API. HTTPS callback required — use ngrok for local dev. Add yourself as a Sandbox tester.",
    uploadHint: {
      label: "TikTok Studio export",
      description:
        "Drop CSV exports from TikTok Studio here. Retention curves and traffic sources live in Studio only — the API doesn't expose them.",
    },
  },
  {
    provider: "instagram",
    label: "Instagram",
    group: "social",
    description:
      "Read your media, insights, comments. Reply to comments. Used by the Social Media Manager.",
    hint:
      "Create a Business app at https://developers.facebook.com, add Instagram product, set up Instagram Login. HTTPS callback required (ngrok). Add yourself as Developer/Admin/Tester.",
    uploadHint: {
      label: "Instagram Insights export",
      description:
        "Optional Meta Business Suite exports for deeper historical signal.",
    },
  },
];

export default async function IntegrationsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    { data: integrations },
    { data: oauthCreds },
    { data: uploads },
    { data: serviceKeys },
  ] = await Promise.all([
    supabase
      .from("integrations")
      .select(
        "id, provider, scopes, handle, display_name, account_label, provider_account_id, created_at",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("user_oauth_credentials")
      .select("provider, client_id_last4"),
    supabase
      .from("creator_analytics_uploads")
      .select("id, provider, label, filename, content_type, size_bytes, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("user_service_keys").select("service, key_last4"),
  ]);

  const integrationsByProvider = new Map<string, Array<{
    id: string;
    provider: string;
    scopes: string[] | null;
    handle: string | null;
    display_name: string | null;
    account_label: string | null;
    provider_account_id: string;
  }>>();
  for (const i of integrations ?? []) {
    const list = integrationsByProvider.get(i.provider as string) ?? [];
    list.push(i as never);
    integrationsByProvider.set(i.provider as string, list);
  }

  const credsByProvider = new Map(
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
  const serviceByName = new Map(
    (serviceKeys ?? []).map((k) => [k.service as string, k.key_last4 as string]),
  );

  // Apify lives inside the TikTok integration's modal as an optional
  // add-on.
  const apifyAddon: IntegrationAddon = {
    service: "apify",
    label: "Apify (trend research)",
    description:
      "Powers TikTok niche/keyword search + competitor profile lookups, and is the video-URL source for transcription. ~$0.30 per 100 scraped results.",
    hint:
      'Get a token at https://console.apify.com/account/integrations. We use the "clockworks/tiktok-scraper" actor.',
    keyHint: "apify_api_...",
    unlocksDescription:
      "Once set, the agent gains: tiktok_search_hashtag, tiktok_search_keyword, tiktok_get_profile (competitor lookup). With an OpenAI key (Settings → AI provider keys), also unlocks tiktok_transcribe_video.",
    configured: serviceByName.has("apify"),
    keyLast4: serviceByName.get("apify") ?? null,
  };

  const providers: ProviderGroup[] = [];
  for (const p of OAUTH_PROVIDERS) {
    let source: "user" | "env" | null = null;
    if (user) {
      const resolved = await getOAuthCredentials(supabase, user.id, p.provider);
      source = resolved?.source ?? null;
    }

    const accounts: ConnectedAccount[] = (
      integrationsByProvider.get(p.provider) ?? []
    ).map((i) => ({
      id: i.id,
      handle: i.handle,
      displayName: i.display_name,
      accountLabel: i.account_label,
      providerAccountId: i.provider_account_id,
      scopes: (i.scopes as string[] | null) ?? [],
    }));

    providers.push({
      provider: p.provider,
      label: p.label,
      group: p.group,
      description: p.description,
      hint: p.hint,
      accounts,
      credentialsConfigured: !!source,
      credentialsLast4: credsByProvider.get(p.provider) ?? null,
      credentialsSource: source,
      uploads: uploadsByProvider.get(p.provider) ?? [],
      uploadHint: p.uploadHint,
      addons: p.provider === "tiktok" ? [apifyAddon] : undefined,
    });
  }

  return <IntegrationsHub providers={providers} />;
}
