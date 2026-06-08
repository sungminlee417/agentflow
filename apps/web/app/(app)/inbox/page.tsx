import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { InboxView, type InboxAccount, type ReplyRow } from "@/components/inbox-view";

export const metadata: Metadata = {
  title: "Inbox",
};

export const dynamic = "force-dynamic";

const SUPPORTED_PROVIDERS = new Set(["instagram", "youtube"]);

export default async function InboxPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: integrations }, { data: replies }] = await Promise.all([
    supabase
      .from("integrations")
      .select(
        "id, provider, handle, display_name, account_label, provider_account_id",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("comment_replies")
      .select(
        "id, integration_id, platform, source_comment_id, source_author, source_text, source_video_id, source_video_url, source_video_title, source_posted_at, draft_text, status, send_error, sent_at, created_at",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const supportedIntegrations = (integrations ?? []).filter((i) =>
    SUPPORTED_PROVIDERS.has(i.provider as string),
  );

  const accounts: InboxAccount[] = supportedIntegrations.map((i) => ({
    id: i.id as string,
    provider: i.provider as string,
    handle: (i.handle as string | null) ?? null,
    displayName: (i.display_name as string | null) ?? null,
    accountLabel: (i.account_label as string | null) ?? null,
    providerAccountId: i.provider_account_id as string,
  }));

  return (
    <InboxView
      accounts={accounts}
      replies={(replies ?? []) as ReplyRow[]}
    />
  );
}
