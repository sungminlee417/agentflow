"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Inbox,
  LogOut,
  Plug,
  Settings,
  User,
  Video,
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Top navigation bar. Replaces the old left sidebar.
//
// IA reasoning: agentflow is now a focused social-media manager with
// two primary destinations (Ideas + Inbox) and a handful of rarely-
// touched settings (Integrations / Settings / Account / Sign out). A
// horizontal top bar with tabs + a right-side avatar dropdown matches
// the actual usage pattern way better than a 260px sidebar that's
// mostly empty.
//
// The AI assistant chat lives in a floating action button (ChatFab)
// pinned to the bottom-right of every authenticated page — same model
// as Intercom / Linear's inbox / etc. Reachable from anywhere without
// being a top-level destination that competes with Ideas + Inbox.

const NAV_LINKS = [
  { href: "/video-ideas", label: "Ideas", Icon: Video },
  { href: "/inbox", label: "Inbox", Icon: Inbox },
];

export function TopNav({
  userEmail,
  hasAnyKey,
}: {
  userEmail: string | null;
  hasAnyKey: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the avatar menu when clicking outside.
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  async function signOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + "/");
  }

  const initial = (userEmail?.[0] ?? "?").toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-200 bg-white/80 px-4 backdrop-blur-md md:px-6 dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="flex items-center gap-1 md:gap-4">
        <Link
          href="/video-ideas"
          className="flex items-center gap-2 pr-2 text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-xs font-bold text-white dark:bg-white dark:text-black">
            a
          </span>
          <span className="hidden sm:inline">agentflow</span>
        </Link>
        <nav className="flex items-center gap-0.5">
          {NAV_LINKS.map(({ href, label, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition ${
                  active
                    ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-2">
        {!hasAnyKey && (
          <Link
            href="/settings"
            className="hidden items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 sm:inline-flex dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            Add an AI provider key
          </Link>
        )}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="Account menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {initial}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-10 z-40 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
              {userEmail && (
                <div className="border-b border-neutral-100 px-3 py-2 text-[11px] text-neutral-500 dark:border-neutral-800">
                  Signed in as
                  <div className="truncate text-neutral-800 dark:text-neutral-200">
                    {userEmail}
                  </div>
                </div>
              )}
              <MenuLink
                href="/settings"
                Icon={User}
                label="Account & settings"
                onClick={() => setMenuOpen(false)}
              />
              <MenuLink
                href="/integrations"
                Icon={Plug}
                label="Integrations"
                onClick={() => setMenuOpen(false)}
              />
              <MenuLink
                href="/settings#theme"
                Icon={Settings}
                label="Appearance"
                onClick={() => setMenuOpen(false)}
              />
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void signOut();
                }}
                className="flex w-full items-center gap-2 border-t border-neutral-100 px-3 py-2 text-left text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuLink({
  href,
  Icon,
  label,
  onClick,
}: {
  href: string;
  Icon: typeof User;
  label: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}
