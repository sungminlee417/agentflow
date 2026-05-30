import { createSupabaseServerClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { ChatView, type StoredMessage } from "@/components/chat-view";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: convo } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("id", id)
    .maybeSingle();
  if (!convo) notFound();

  const { data: messages } = await supabase
    .from("messages")
    .select("id, role, content_json, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  return (
    <ChatView
      conversationId={id}
      title={convo.title}
      initialMessages={(messages ?? []) as StoredMessage[]}
    />
  );
}
