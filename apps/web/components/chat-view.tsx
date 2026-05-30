"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content_json: unknown;
  created_at: string;
};

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

// Extract a plain-text rendering from whatever the message content is.
// For v1 we store either a string or a CoreMessage content array; both
// reduce to display text for now. Tool-call rendering comes later.
function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) return String(p.text);
        return "";
      })
      .join("");
  }
  return "";
}

function storedToUi(m: StoredMessage): UiMessage {
  return { id: m.id, role: m.role, text: toText(m.content_json) };
}

export function ChatView({
  conversationId,
  title,
  initialMessages = [],
}: {
  conversationId?: string;
  title?: string | null;
  initialMessages?: StoredMessage[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<UiMessage[]>(
    initialMessages.map(storedToUi),
  );
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;

    const userMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
    };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.text,
          })),
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Request failed");
      const data = (await res.json()) as {
        conversation_id: string;
        assistant: { id: string; text: string };
      };

      setMessages((m) => [
        ...m,
        { id: data.assistant.id, role: "assistant", text: data.assistant.text },
      ]);

      // If this was a new conversation, route into its permanent URL.
      if (!conversationId) {
        router.replace(`/chat/${data.conversation_id}`);
        router.refresh();
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Pop the optimistic user message back into the input so it isn't lost.
      setMessages((m) => m.slice(0, -1));
      setInput(text);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-neutral-800 px-6 py-3 text-sm text-neutral-400">
        {title ?? (conversationId ? "Conversation" : "New chat")}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">
          {messages.length === 0 && !pending && (
            <div className="mt-24 text-center text-neutral-500">
              <p className="text-lg">What do you want to work on?</p>
              <p className="mt-2 text-sm">
                Configure your provider key in Settings, then start typing.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[80%] rounded-2xl bg-neutral-800 px-4 py-3 text-sm"
                  : "max-w-[80%] rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
              }
            >
              <p className="whitespace-pre-wrap">{m.text}</p>
            </div>
          ))}

          {pending && (
            <div className="max-w-[80%] rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-500">
              Thinking…
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <form
        onSubmit={send}
        className="border-t border-neutral-800 bg-neutral-950 px-6 py-4"
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(e as unknown as React.FormEvent);
              }
            }}
            placeholder="Send a message…"
            className="flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending || input.trim().length === 0}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
