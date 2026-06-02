import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VideoIdeasList, type VideoIdeaRow } from "@/components/video-ideas-list";

export default async function VideoIdeasPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Auto-prune expired + dismissed before rendering so the page never
  // surfaces stale rows even if the user hasn't clicked Refresh.
  const nowIso = new Date().toISOString();
  await supabase
    .from("video_ideas")
    .delete()
    .eq("user_id", user.id)
    .or(`expires_at.lt.${nowIso},status.eq.dismissed`);

  const [{ data: ideas }, { data: settings }, { data: tiktokInt }] =
    await Promise.all([
      supabase
        .from("video_ideas")
        .select(
          "id, provider, title, hook, format, rationale, kind, source_refs, expires_at, status, created_at",
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("video_ideas_settings")
        .select("target_count, provider")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("integrations")
        .select("provider")
        .eq("user_id", user.id)
        .eq("provider", "tiktok")
        .maybeSingle(),
    ]);

  return (
    <VideoIdeasList
      initial={(ideas ?? []) as VideoIdeaRow[]}
      targetCount={settings?.target_count ?? 10}
      tiktokConnected={!!tiktokInt}
    />
  );
}
