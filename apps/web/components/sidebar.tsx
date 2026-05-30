"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type ConversationSummary = {
  id: string;
  title: string | null;
  updated_at: string;
};

export function Sidebar({
  conversations,
  hasAnyKey,
}: {
  conversations: ConversationSummary[];
  hasAnyKey: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-screen flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 p-3">
        <Link
          href="/chat"
          className="block rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-center text-sm font-medium transition hover:bg-neutral-800"
        >
          + New chat
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-neutral-500">
            No conversations yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => {
              const href = `/chat/${c.id}`;
              const active = pathname === href;
              return (
                <li key={c.id}>
                  <Link
                    href={href}
                    className={`block truncate rounded-md px-3 py-2 text-sm transition ${
                      active
                        ? "bg-neutral-800 text-white"
                        : "text-neutral-300 hover:bg-neutral-900"
                    }`}
                  >
                    {c.title ?? "Untitled"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3 text-sm">
        {!hasAnyKey && (
          <div className="mb-3 rounded-md border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            Add an API key in Settings to start chatting.
          </div>
        )}
        <Link
          href="/settings"
          className={`block rounded-md px-3 py-2 transition ${
            pathname === "/settings"
              ? "bg-neutral-800 text-white"
              : "text-neutral-300 hover:bg-neutral-900"
          }`}
        >
          Settings
        </Link>
        <button
          onClick={signOut}
          className="mt-1 block w-full rounded-md px-3 py-2 text-left text-neutral-400 transition hover:bg-neutral-900"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
