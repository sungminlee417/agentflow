"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { ThemeToggle } from "@/components/theme-toggle";
import { MANAGERS } from "@agentflow/core";

type ConversationSummary = {
  id: string;
  title: string | null;
  updated_at: string;
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500";

export function Sidebar({
  conversations,
  hasAnyKey,
  onClose,
}: {
  conversations: ConversationSummary[];
  hasAnyKey: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function navLinkClass(href: string, exact = true) {
    const active = exact ? pathname === href : pathname.startsWith(href);
    return `block rounded-md px-3 py-2 text-sm transition ${FOCUS_RING} ${
      active
        ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-white"
        : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
    }`;
  }

  return (
    <aside className="flex h-full flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="space-y-1 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <Link
          href="/chat"
          onClick={onClose}
          className={`mb-1 block rounded-md border border-neutral-300 bg-white px-3 py-2 text-center text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 ${FOCUS_RING} dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800`}
        >
          + New chat
        </Link>
        <Link
          href="/video-ideas"
          onClick={onClose}
          className={navLinkClass("/video-ideas", false)}
        >
          Video ideas
        </Link>
        <Link
          href="/activity"
          onClick={onClose}
          className={navLinkClass("/activity")}
        >
          Activity
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
                    onClick={onClose}
                    className={`block truncate rounded-md px-3 py-2 text-sm transition ${FOCUS_RING} ${
                      active
                        ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-white"
                        : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
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

      <div className="border-t border-neutral-200 px-3 pt-3 text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:border-neutral-800">
        Managers
      </div>
      <nav className="space-y-1 px-3 pb-3 pt-1">
        {MANAGERS.map((m) => {
          const href = `/managers/${m.slug}`;
          const active = pathname === href;
          const isComingSoon = m.status === "coming_soon";
          return (
            <Link
              key={m.slug}
              href={href}
              onClick={onClose}
              className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition ${FOCUS_RING} ${
                active
                  ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-white"
                  : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
              }`}
            >
              <span className="truncate">{m.label}</span>
              {isComingSoon && (
                <span className="shrink-0 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                  Soon
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-neutral-200 p-3 text-sm dark:border-neutral-800">
        {!hasAnyKey && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            Add an AI provider key in Settings to start chatting.
          </div>
        )}
        <Link
          href="/integrations"
          onClick={onClose}
          className={navLinkClass("/integrations")}
        >
          Integrations
        </Link>
        <Link
          href="/settings"
          onClick={onClose}
          className={navLinkClass("/settings")}
        >
          Settings
        </Link>
        <ThemeToggle />
        <button
          onClick={signOut}
          className={`mt-1 block w-full rounded-md px-3 py-2 text-left text-sm text-neutral-500 transition hover:bg-neutral-100 ${FOCUS_RING} dark:text-neutral-400 dark:hover:bg-neutral-900`}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
