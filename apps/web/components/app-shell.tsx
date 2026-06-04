"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar";

type ConversationSummary = {
  id: string;
  title: string | null;
  updated_at: string;
};

export function AppShell({
  conversations,
  hasAnyKey,
  children,
}: {
  conversations: ConversationSummary[];
  hasAnyKey: boolean;
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="relative flex h-screen overflow-hidden">
      {/* ── Mobile overlay backdrop ─────────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      {/*
       *  Desktop (md+): static column, always visible — full viewport
       *  height, doesn't scroll with the main panel.
       *  Mobile       : fixed off-canvas panel, slides in/out via translate.
       */}
      <div
        className={[
          // Shared
          "z-30 h-screen w-[260px] shrink-0 transition-transform duration-200",
          // Mobile: fixed, full height, slides in from the left
          "fixed inset-y-0 left-0 md:relative md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        ].join(" ")}
      >
        <Sidebar
          conversations={conversations}
          hasAnyKey={hasAnyKey}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      {/* ── Main content area ───────────────────────────────────────── */}
      <main className="h-screen flex-1 overflow-y-auto">
        {/* Hamburger / close button – only visible on mobile. 44×44 tap
            target meets the iOS HIG / WCAG minimum. */}
        <button
          type="button"
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((o) => !o)}
          className="fixed left-2.5 top-2.5 z-40 flex h-11 w-11 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 shadow-sm transition hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 active:bg-neutral-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:active:bg-neutral-700 md:hidden"
        >
          {sidebarOpen ? (
            <X className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Menu className="h-5 w-5" aria-hidden="true" />
          )}
        </button>

        {children}
      </main>
    </div>
  );
}
