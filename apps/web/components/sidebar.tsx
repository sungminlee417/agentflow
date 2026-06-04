"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Code2,
  Cog,
  LogOut,
  MessageSquare,
  Plug,
  Plus,
  Video,
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { MANAGERS } from "@agentflow/core";

type ConversationSummary = {
  id: string;
  title: string | null;
  updated_at: string;
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500";

const ICON_CLS = "h-4 w-4 shrink-0";

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
              <Video className={ICON_CLS} aria-hidden="true" />
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
                <Code2 className={ICON_CLS} aria-hidden="true" />
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
              <Activity className={ICON_CLS} aria-hidden="true" />
              <span>Activity</span>
            </span>
          </Link>
        </nav>

        {/* Chat section */}
        <div className="border-t border-neutral-200 px-2 pt-3 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5">
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              Chat
            </span>
            <Link
              href="/chat"
              onClick={onClose}
              className={`flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 ${FOCUS_RING} dark:hover:bg-neutral-800 dark:hover:text-neutral-100`}
              title="New chat"
              aria-label="New chat"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
          {conversations.length === 0 ? (
            <Link
              href="/chat"
              onClick={onClose}
              className={`mx-1 mb-3 flex items-center justify-between rounded-md border border-dashed border-neutral-300 px-2.5 py-2 text-[11px] text-neutral-500 transition hover:border-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 ${FOCUS_RING} dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-900 dark:hover:text-neutral-300`}
            >
              <span>No conversations yet.</span>
              <span className="font-medium">Start one →</span>
            </Link>
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
            className={`mx-2 mb-2 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 transition hover:bg-amber-100 ${FOCUS_RING} dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50`}
          >
            <AlertTriangle
              className="mt-0.5 h-3 w-3 shrink-0"
              aria-hidden="true"
            />
            <span>Add an AI key in Settings to start chatting</span>
          </Link>
        )}
        <nav className="space-y-0.5">
          <Link
            href="/integrations"
            onClick={onClose}
            className={navLinkClass(isActive("/integrations"))}
          >
            <span className="flex items-center gap-2">
              <Plug className={ICON_CLS} aria-hidden="true" />
              <span>Integrations</span>
            </span>
          </Link>
          <Link
            href="/settings"
            onClick={onClose}
            className={navLinkClass(isActive("/settings"))}
          >
            <span className="flex items-center gap-2">
              <Cog className={ICON_CLS} aria-hidden="true" />
              <span>Settings</span>
            </span>
          </Link>
          <button
            type="button"
            onClick={signOut}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-500 transition hover:bg-neutral-100 ${FOCUS_RING} dark:text-neutral-400 dark:hover:bg-neutral-900`}
          >
            <LogOut className={ICON_CLS} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </nav>
      </div>
    </aside>
  );
}
