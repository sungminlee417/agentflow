import type { Metadata } from "next";
import { ChatView } from "@/components/chat-view";

export const metadata: Metadata = {
  title: "New chat",
};

export default function NewChatPage() {
  return <ChatView />;
}
