"use client";

import { useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { ChatView, type StoredMessage } from "@/components/chat-view";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Floating action button + slide-out panel that hosts the AI chat
// from any authenticated page. Replaces the top-level /chat nav link
// — chat is a tool you summon, not a destination.
//
// Behavior:
//   - Closed: floating button bottom-right.
//   - Open: full-height panel slides in from the right (mobile: full-
//     screen modal). Loads the user's most-recent conversation by
//     default; "New chat" button starts a fresh one.
//   - Persists open/closed state to localStorage so it survives
//     navigation between pages.
//   - Hidden on /login (no auth shell wraps that route).

const STORAGE_KEY = "agentflow:chatfab:open";

export function ChatFab() {
  const [open, setOpen] = useState(false);
  const [convoId, setConvoId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Restore open state on mount.
  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") setOpen(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open]);

  // Lazy-load most-recent conversation when first opened.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data: convos } = await supabase
        .from("conversations")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      const id = convos?.[0]?.id as string | undefined;
      if (id) {
        setConvoId(id);
        const { data: msgs } = await supabase
          .from("messages")
          .select("id, role, content_json, created_at")
          .eq("conversation_id", id)
          .order("created_at", { ascending: true });
        if (!cancelled) {
          setMessages((msgs ?? []) as StoredMessage[]);
        }
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  function startNewChat() {
    setConvoId(undefined);
    setMessages([]);
  }

  return (
    <>
      {/* Floating button — hidden when panel is open so the close button takes over */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open AI assistant"
          title="AI assistant"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg transition hover:scale-105 hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          <MessageSquare className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {/* Backdrop on mobile only — desktop panel is non-modal so the
          user can keep clicking around the page with chat visible. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Slide-out panel */}
      <aside
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-120 flex-col border-l border-neutral-200 bg-white shadow-xl transition-transform duration-200 dark:border-neutral-800 dark:bg-neutral-950 ${
          open ? "translate-x-0" : "pointer-events-none translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex h-12 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <MessageSquare
              className="h-4 w-4 text-neutral-500"
              aria-hidden="true"
            />
            <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              AI assistant
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={startNewChat}
              className="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              New chat
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close AI assistant"
              className="rounded-md p-1.5 text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {/* Re-mount ChatView whenever the conversation id changes so
              it picks up the right initialMessages payload. */}
          {open && (
            <ChatView
              key={convoId ?? "new"}
              conversationId={convoId}
              initialMessages={messages}
              title={null}
              variant="embedded"
            />
          )}
        </div>
      </aside>
    </>
  );
}
