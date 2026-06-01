"use client";

import { useState } from "react";
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
        {/* Hamburger / close button – only visible on mobile */}
        <button
          type="button"
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          onClick={() => setSidebarOpen((o) => !o)}
          className="fixed left-3 top-3 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 shadow-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 md:hidden"
        >
          {sidebarOpen ? "✕" : "☰"}
        </button>

        {children}
      </main>
    </div>
  );
}
