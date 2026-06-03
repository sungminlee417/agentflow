"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
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

const MAX_VISIBLE_CONVOS = 6;

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
  const [showAllConvos, setShowAllConvos] = useState(false);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function navLinkClass(active: boolean) {
    return `flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm transition ${FOCUS_RING} ${
      active
        ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
        : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
    }`;
  }

  function isActive(href: string, exact = true): boolean {
    return exact ? pathname === href : pathname.startsWith(href);
  }

  const visibleConvos = showAllConvos
    ? conversations
    : conversations.slice(0, MAX_VISIBLE_CONVOS);

  // Only render "Code" if the GitHub-backed manager has anything to do.
  const codeManager = MANAGERS.find((m) => m.slug === "code");

  return (
    <aside className="flex h-full flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      {/* Brand */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-neutral-900 text-xs font-bold text-white dark:bg-white dark:text-black">
          a
        </span>
        <span className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          agentflow
        </span>
      </div>

      {/* Primary nav + chat history (scrolls if needed) */}
      <div className="flex-1 overflow-y-auto">
        <nav className="space-y-0.5 px-2 py-3">
          <Link
            href="/video-ideas"
            onClick={onClose}
            className={navLinkClass(isActive("/video-ideas", false))}
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">📹</span>
              <span>Video ideas</span>
            </span>
          </Link>
          {codeManager && (
            <Link
              href={`/managers/${codeManager.slug}`}
              onClick={onClose}
              className={navLinkClass(
                isActive(`/managers/${codeManager.slug}`),
              )}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden="true">⚡</span>
                <span>{codeManager.label}</span>
              </span>
            </Link>
          )}
          <Link
            href="/activity"
            onClick={onClose}
            className={navLinkClass(isActive("/activity"))}
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">📈</span>
              <span>Activity</span>
            </span>
          </Link>
        </nav>

        {/* Chat section */}
        <div className="border-t border-neutral-200 px-2 pt-3 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              Chat
            </span>
            <Link
              href="/chat"
              onClick={onClose}
              className={`flex h-5 w-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 ${FOCUS_RING} dark:hover:bg-neutral-800 dark:hover:text-neutral-100`}
              title="New chat"
              aria-label="New chat"
            >
              +
            </Link>
          </div>
          {conversations.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-neutral-500">
              No conversations yet.
            </p>
          ) : (
            <ul className="space-y-0.5 pb-3">
              {visibleConvos.map((c) => {
                const href = `/chat/${c.id}`;
                const active = pathname === href;
                return (
                  <li key={c.id}>
                    <Link
                      href={href}
                      onClick={onClose}
                      className={`block truncate rounded-md px-2.5 py-1.5 text-xs transition ${FOCUS_RING} ${
                        active
                          ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                          : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
                      }`}
                    >
                      {c.title ?? "Untitled"}
                    </Link>
                  </li>
                );
              })}
              {conversations.length > MAX_VISIBLE_CONVOS && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowAllConvos((s) => !s)}
                    className={`block w-full rounded-md px-2.5 py-1 text-left text-[11px] text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 ${FOCUS_RING} dark:hover:bg-neutral-900 dark:hover:text-neutral-100`}
                  >
                    {showAllConvos
                      ? "Show less"
                      : `+${conversations.length - MAX_VISIBLE_CONVOS} more`}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* Footer (always pinned to bottom) */}
      <div className="border-t border-neutral-200 px-2 pb-2 pt-2 dark:border-neutral-800">
        {!hasAnyKey && (
          <Link
            href="/settings"
            onClick={onClose}
            className="mx-2 mb-2 block rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 transition hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
          >
            ⚠ Add an AI key in Settings to start chatting
          </Link>
        )}
        <nav className="space-y-0.5">
          <Link
            href="/integrations"
            onClick={onClose}
            className={navLinkClass(isActive("/integrations"))}
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">🔌</span>
              <span>Integrations</span>
            </span>
          </Link>
          <Link
            href="/settings"
            onClick={onClose}
            className={navLinkClass(isActive("/settings"))}
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">⚙</span>
              <span>Settings</span>
            </span>
          </Link>
          <ThemeToggle />
          <button
            type="button"
            onClick={signOut}
            className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-500 transition hover:bg-neutral-100 ${FOCUS_RING} dark:text-neutral-400 dark:hover:bg-neutral-900`}
          >
            Sign out
          </button>
        </nav>
      </div>
    </aside>
  );
}
