import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  VideoIdeasList,
  type AccountGroup,
  type VideoIdeaRow,
  type LinkableAccount,
} from "@/components/video-ideas-list";

export const metadata: Metadata = {
  title: "Video ideas",
};

// Force-dynamic so router.refresh() always re-runs the data fetch.
// Without this, Next can decide a route is statically-rendered-with-
// dynamic-functions and end up serving slightly stale ideas data
// after a status PATCH.
export const dynamic = "force-dynamic";

// Providers the video-ideas agent generates ideas for + the Mark-Done
// modal can link to. Now identical — every linkable provider also has
// a research toolset (TT via Display+Apify, YT via Data+Analytics,
// IG via Graph).
const SUPPORTED_PROVIDERS = new Set(["tiktok", "youtube", "instagram"]);

function buildLabel(
  handle: string | null,
  displayName: string | null,
  accountLabel: string | null,
): string {
  if (accountLabel) return accountLabel;
  if (displayName && handle) return `${displayName} (@${handle})`;
  if (displayName) return displayName;
  if (handle) return `@${handle}`;
  return "Account";
}

export default async function VideoIdeasPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Prune dismissed + naturally-expired pending ideas across ALL of
  // the user's integrations in one pass. Done ideas are kept (they
  // feed the review loop) regardless of expires_at.
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
    .select(
      "id, provider, handle, display_name, account_label, provider_account_id",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const supportedIntegrations = (integrations ?? []).filter((i) =>
    SUPPORTED_PROVIDERS.has(i.provider as string),
  );

  // linkableAccounts powers the Mark-Done modal's per-platform URL
  // input list. Same as supported integrations — every account a user
  // could publish to is also one the agent can research.
  const linkableAccounts: LinkableAccount[] = supportedIntegrations.map(
    (i) => ({
      id: i.id as string,
      platform: i.provider as string,
      label: buildLabel(
        i.handle as string | null,
        i.display_name as string | null,
        i.account_label as string | null,
      ),
    }),
  );

  if (supportedIntegrations.length === 0) {
    return (
      <VideoIdeasList
        groups={[]}
        linkableAccounts={[]}
        allIdeas={[]}
      />
    );
  }

  // One DB round per cross-cutting table, then bucket by integration_id
  // client-side so the renderer can lay them out as group sections.
  const accountIds = supportedIntegrations.map((i) => i.id as string);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const [
    { data: ideasData },
    { data: settingsRows },
    { data: jobRows },
  ] = await Promise.all([
    supabase
      .from("video_ideas")
      .select(
        "id, provider, integration_id, title, hook, format, rationale, kind, source_refs, expires_at, status, priority, created_at, script, post_title, description, hashtags, cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound, saturation_warning, platforms, posted_video_id, posted_video_url, posted_at, performance_verdict, performance_score, performance_review, performance_stats, last_reviewed_at, next_review_at",
      )
      .eq("user_id", user.id)
      .in("integration_id", accountIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("video_ideas_settings")
      .select("integration_id, target_count, preferences")
      .eq("user_id", user.id)
      .in("integration_id", accountIds),
    supabase
      .from("video_ideas_generation_jobs")
      .select(
        "id, integration_id, status, step_count, step_label, requested_count, started_at, updated_at",
      )
      .eq("user_id", user.id)
      .in("integration_id", accountIds)
      .eq("status", "running")
      .gt("updated_at", fiveMinAgo)
      .order("started_at", { ascending: false }),
  ]);

  const allIdeas = (ideasData ?? []) as VideoIdeaRow[];

  // Hydrate per-platform posts in ONE batch across every loaded idea.
  if (allIdeas.length > 0) {
    const ideaIds = allIdeas.map((i) => i.id);
    const { data: postRows } = await supabase
      .from("video_idea_posts")
      .select(
        "id, idea_id, integration_id, platform, posted_video_id, posted_video_url, posted_at, performance_verdict, performance_score, performance_review, performance_stats, last_reviewed_at, next_review_at",
      )
      .in("idea_id", ideaIds)
      .order("posted_at", { ascending: true });
    const byIdea = new Map<string, VideoIdeaRow["posts"]>();
    for (const p of postRows ?? []) {
      const list = byIdea.get(p.idea_id as string) ?? [];
      list.push({
        id: p.id as string,
        integration_id: p.integration_id as string,
        platform: p.platform as string,
        posted_video_id: p.posted_video_id as string,
        posted_video_url: (p.posted_video_url as string | null) ?? null,
        posted_at: p.posted_at as string,
        performance_verdict:
          (p.performance_verdict as VideoIdeaRow["performance_verdict"]) ??
          null,
        performance_score: (p.performance_score as number | null) ?? null,
        performance_review: (p.performance_review as string | null) ?? null,
        performance_stats:
          (p.performance_stats as VideoIdeaRow["performance_stats"]) ?? null,
        last_reviewed_at: (p.last_reviewed_at as string | null) ?? null,
        next_review_at: (p.next_review_at as string | null) ?? null,
      });
      byIdea.set(p.idea_id as string, list);
    }
    for (let i = 0; i < allIdeas.length; i += 1) {
      const row = allIdeas[i]!;
      row.posts = byIdea.get(row.id) ?? [];
    }
  }

  // Bucket settings + active jobs by integration_id.
  const settingsByAccount = new Map<
    string,
    { target_count: number; preferences: string | null }
  >();
  for (const s of settingsRows ?? []) {
    settingsByAccount.set(s.integration_id as string, {
      target_count: (s.target_count as number) ?? 10,
      preferences: (s.preferences as string | null) ?? null,
    });
  }
  const jobByAccount = new Map<string, AccountGroup["activeJob"]>();
  for (const j of jobRows ?? []) {
    const acctId = j.integration_id as string;
    if (jobByAccount.has(acctId)) continue; // keep most recent (already ordered)
    jobByAccount.set(acctId, {
      id: j.id as string,
      step_count: (j.step_count as number) ?? 0,
      step_label: (j.step_label as string | null) ?? "Working…",
      requested_count: (j.requested_count as number | null) ?? null,
      started_at: j.started_at as string,
    });
  }

  // Per-account idea buckets, preserving the created_at DESC order
  // from the master query.
  const ideasByAccount = new Map<string, VideoIdeaRow[]>();
  for (const idea of allIdeas) {
    const acctId = idea.integration_id as string | null;
    if (!acctId) continue;
    const list = ideasByAccount.get(acctId) ?? [];
    list.push(idea);
    ideasByAccount.set(acctId, list);
  }

  const groups: AccountGroup[] = supportedIntegrations.map((i) => {
    const accountId = i.id as string;
    const settings = settingsByAccount.get(accountId);
    return {
      account: {
        id: accountId,
        provider: i.provider as string,
        handle: (i.handle as string | null) ?? null,
        displayName: (i.display_name as string | null) ?? null,
        accountLabel: (i.account_label as string | null) ?? null,
        providerAccountId: i.provider_account_id as string,
      },
      ideas: ideasByAccount.get(accountId) ?? [],
      targetCount: settings?.target_count ?? 10,
      preferences: settings?.preferences ?? null,
      activeJob: jobByAccount.get(accountId) ?? null,
    };
  });

  return (
    <VideoIdeasList
      groups={groups}
      linkableAccounts={linkableAccounts}
      allIdeas={allIdeas}
    />
  );
}
