import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  VideoIdeasList,
  type VideoIdeaRow,
  type IdeasAccount,
} from "@/components/video-ideas-list";

// Only providers that the video-ideas agent currently supports.
const SUPPORTED_PROVIDERS = new Set(["tiktok"]);

export default async function VideoIdeasPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Prune expired + dismissed before rendering across all accounts.
  const nowIso = new Date().toISOString();
  await supabase
    .from("video_ideas")
    .delete()
    .eq("user_id", user.id)
    .or(`expires_at.lt.${nowIso},status.eq.dismissed`);

  const { data: integrations } = await supabase
    .from("integrations")
    .select("id, provider, handle, display_name, account_label, provider_account_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const accounts: IdeasAccount[] = (integrations ?? [])
    .filter((i) => SUPPORTED_PROVIDERS.has(i.provider as string))
    .map((i) => ({
      id: i.id as string,
      provider: i.provider as string,
      handle: (i.handle as string | null) ?? null,
      displayName: (i.display_name as string | null) ?? null,
      accountLabel: (i.account_label as string | null) ?? null,
      providerAccountId: i.provider_account_id as string,
    }));

  const sp = await searchParams;
  const selectedAccountId =
    accounts.find((a) => a.id === sp.account)?.id ?? accounts[0]?.id ?? null;

  let ideas: VideoIdeaRow[] = [];
  let targetCount = 10;
  if (selectedAccountId) {
    const [{ data: ideasData }, { data: settings }] = await Promise.all([
      supabase
        .from("video_ideas")
        .select(
          "id, provider, integration_id, title, hook, format, rationale, kind, source_refs, expires_at, status, created_at, script, post_title, description, hashtags, cta, visual_notes",
        )
        .eq("user_id", user.id)
        .eq("integration_id", selectedAccountId)
        .order("created_at", { ascending: false }),
      supabase
        .from("video_ideas_settings")
        .select("target_count")
        .eq("user_id", user.id)
        .eq("integration_id", selectedAccountId)
        .maybeSingle(),
    ]);
    ideas = (ideasData ?? []) as VideoIdeaRow[];
    targetCount = settings?.target_count ?? 10;
  }

  return (
    <VideoIdeasList
      accounts={accounts}
      selectedAccountId={selectedAccountId}
      initial={ideas}
      targetCount={targetCount}
    />
  );
}
