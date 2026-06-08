import { TopNav } from "@/components/top-nav";
import { ChatFab } from "@/components/chat-fab";

export function AppShell({
  userEmail,
  hasAnyKey,
  children,
}: {
  userEmail: string | null;
  hasAnyKey: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <TopNav userEmail={userEmail} hasAnyKey={hasAnyKey} />
      <main className="flex-1">{children}</main>
      <ChatFab />
    </div>
  );
}
