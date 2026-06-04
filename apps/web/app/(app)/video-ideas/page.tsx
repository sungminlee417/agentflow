import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  VideoIdeasList,
  type VideoIdeaRow,
  type IdeasAccount,
  type ActiveGenerationJob,
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

  // Prune dismissed + naturally-expired pending ideas. Done ideas are
  // kept regardless of expires_at — they're the user's post history
  // and feed the review loop. Scheduled ideas are kept too.
  const nowIso = new Date().toISOString();
  await supabase
    .from("video_ideas")
    .delete()
    .eq("user_id", user.id)
    .eq("status", "dismissed");
  await supabase
    .from("video_ideas")
    .delete()
    .eq("user_id", user.id)
    .eq("status", "pending")
    .lt("expires_at", nowIso);

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
  let preferences: string | null = null;
  let activeJob: ActiveGenerationJob | null = null;
  if (selectedAccountId) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const [{ data: ideasData }, { data: settings }, { data: jobRow }] =
      await Promise.all([
        supabase
          .from("video_ideas")
          .select(
            "id, provider, integration_id, title, hook, format, rationale, kind, source_refs, expires_at, status, priority, created_at, script, post_title, description, hashtags, cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound, saturation_warning, posted_video_id, posted_video_url, posted_at, performance_verdict, performance_score, performance_review, performance_stats, last_reviewed_at, next_review_at",
          )
          .eq("user_id", user.id)
          .eq("integration_id", selectedAccountId)
          .order("created_at", { ascending: false }),
        supabase
          .from("video_ideas_settings")
          .select("target_count, preferences")
          .eq("user_id", user.id)
          .eq("integration_id", selectedAccountId)
          .maybeSingle(),
        supabase
          .from("video_ideas_generation_jobs")
          .select(
            "id, status, step_count, step_label, requested_count, started_at, updated_at",
          )
          .eq("user_id", user.id)
          .eq("integration_id", selectedAccountId)
          .eq("status", "running")
          .gt("updated_at", fiveMinAgo)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
    ideas = (ideasData ?? []) as VideoIdeaRow[];
    targetCount = settings?.target_count ?? 10;
    preferences = (settings?.preferences as string | null | undefined) ?? null;
    if (jobRow) {
      activeJob = {
        id: jobRow.id as string,
        step_count: (jobRow.step_count as number) ?? 0,
        step_label: (jobRow.step_label as string | null) ?? "Working…",
        requested_count: (jobRow.requested_count as number | null) ?? null,
        started_at: jobRow.started_at as string,
      };
    }
  }

  return (
    <VideoIdeasList
      accounts={accounts}
      selectedAccountId={selectedAccountId}
      initial={ideas}
      targetCount={targetCount}
      preferences={preferences}
      initialActiveJob={activeJob}
    />
  );
}
