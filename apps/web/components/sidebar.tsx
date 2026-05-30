"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { ThemeToggle } from "@/components/theme-toggle";

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
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function deleteConversation(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      // If we're currently viewing the deleted chat, go home.
      if (pathname === `/chat/${id}`) {
        router.push("/chat");
      }
      router.refresh();
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <aside className="flex h-screen flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
        <Link
          href="/chat"
          className="block rounded-md border border-neutral-300 bg-white px-3 py-2 text-center text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
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
              const isDeleting = deletingId === c.id;
              return (
                <li key={c.id} className="group relative flex items-center">
                  <Link
                    href={href}
                    className={`block flex-1 truncate rounded-md px-3 py-2 text-sm transition pr-8 ${
                      active
                        ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-white"
                        : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
                    }`}
                  >
                    {c.title ?? "Untitled"}
                  </Link>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      deleteConversation(c.id);
                    }}
                    disabled={isDeleting}
                    aria-label="Delete conversation"
                    className="absolute right-1 flex h-6 w-6 items-center justify-center rounded opacity-0 transition group-hover:opacity-100 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isDeleting ? (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    ) : (
                      <span aria-hidden>×</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-200 p-3 text-sm dark:border-neutral-800">
        {!hasAnyKey && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            Add an API key in Settings to start chatting.
          </div>
        )}
        <Link
          href="/settings"
          className={`block rounded-md px-3 py-2 transition ${
            pathname === "/settings"
              ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-white"
              : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          }`}
        >
          Settings
        </Link>
        <ThemeToggle />
        <button
          onClick={signOut}
          className="mt-1 block w-full rounded-md px-3 py-2 text-left text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
