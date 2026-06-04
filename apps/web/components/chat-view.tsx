"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ToolStep } from "@/components/tool-step";

export type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content_json: unknown;
  created_at: string;
};

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; name: string; input: unknown; id?: string }
  | { kind: "tool-result"; name: string; output: unknown; id?: string };

function parseContent(content: unknown): Part[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: Part[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      out.push({ kind: "text", text: p });
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    const type = String(rec.type ?? "");
    if (type === "text" && typeof rec.text === "string") {
      out.push({ kind: "text", text: rec.text });
    } else if (type === "tool-call" || type === "tool_call") {
      out.push({
        kind: "tool-call",
        name: String(rec.toolName ?? rec.name ?? "tool"),
        input: rec.input ?? rec.args ?? null,
        id: typeof rec.toolCallId === "string" ? rec.toolCallId : undefined,
      });
    } else if (type === "tool-result" || type === "tool_result") {
      out.push({
        kind: "tool-result",
        name: String(rec.toolName ?? rec.name ?? "tool"),
        output: rec.output ?? rec.result ?? rec.content ?? null,
        id: typeof rec.toolCallId === "string" ? rec.toolCallId : undefined,
      });
    }
  }
  return out;
}

type Block =
  | { kind: "user-text"; key: string; text: string }
  | { kind: "assistant-text"; key: string; text: string; streaming?: boolean }
  | {
      kind: "tool-step";
      key: string;
      name: string;
      input: unknown;
      output: unknown;
      status: "running" | "done" | "error";
    };

function flattenHistory(messages: StoredMessage[]): Block[] {
  const resultsByCallId = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of parseContent(m.content_json)) {
      if (p.kind === "tool-result" && p.id) resultsByCallId.set(p.id, p.output);
    }
  }
  const blocks: Block[] = [];
  let counter = 0;
  for (const m of messages) {
    if (m.role === "system" || m.role === "tool") continue;
    for (const p of parseContent(m.content_json)) {
      const key = `${m.id}-${counter++}`;
      if (p.kind === "text") {
        if (!p.text) continue;
        blocks.push({
          kind: m.role === "user" ? "user-text" : "assistant-text",
          key,
          text: p.text,
        });
      } else if (p.kind === "tool-call") {
        const output = p.id ? resultsByCallId.get(p.id) : undefined;
        blocks.push({
          kind: "tool-step",
          key,
          name: p.name,
          input: p.input,
          output,
          status: output === undefined ? "running" : "done",
        });
      }
    }
  }
  return blocks;
}

// Streaming parts are built up as UI-message-stream events arrive.
type StreamPart =
  | { kind: "text"; id: string; text: string }
  | {
      kind: "tool"; id: string; name: string;
      input: unknown; output: unknown;
      status: "running" | "done" | "error";
    };

type StreamBlock = Exclude<Block, { kind: "user-text" }>;

function streamPartsToBlocks(parts: StreamPart[]): StreamBlock[] {
  return parts.map((p, i) => {
    if (p.kind === "text") {
      return {
        kind: "assistant-text" as const,
        key: `stream-${i}`,
        text: p.text,
      };
    }
    return {
      kind: "tool-step" as const,
      key: `stream-${i}`,
      name: p.name,
      input: p.input,
      output: p.output,
      status: p.status,
    };
  });
}

// Parse the SSE stream emitted by toUIMessageStreamResponse(). Yields
// each `data:` event payload as parsed JSON. Tolerant of multi-line
// events and partial chunks.
async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        for (const line of ev.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            yield JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // ignore malformed line
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-sm whitespace-pre-wrap text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
        {text}
      </div>
    </div>
  );
}

function StreamingDots() {
  return (
    <span className="inline-flex gap-1 align-middle">
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

function AssistantText({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="text-sm text-neutral-900 dark:text-neutral-100">
      {text && <Markdown>{text}</Markdown>}
      {streaming && (
        <div className="mt-1">
          <StreamingDots />
        </div>
      )}
    </div>
  );
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
  const [history, setHistory] = useState<StoredMessage[]>(initialMessages);
  const [convoId, setConvoId] = useState<string | undefined>(conversationId);
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  const [streamParts, setStreamParts] = useState<StreamPart[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // When the server passes fresh initialMessages (e.g. router.refresh
  // on an existing chat), adopt them and clear streaming state — the
  // DB now has the new turn. We only replace when initialMessages grew,
  // so a transient empty fetch during a race can't erase content.
  useEffect(() => {
    if (initialMessages.length > history.length) {
      setHistory(initialMessages);
      setStreamParts([]);
      setPendingUserText(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessages]);

  const historyBlocks = useMemo(() => flattenHistory(history), [history]);
  const streamBlocks = useMemo(
    () => streamPartsToBlocks(streamParts),
    [streamParts],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [historyBlocks, streamBlocks, pendingUserText]);

  function handleStreamEvent(event: Record<string, unknown>) {
    const type = String(event.type ?? "");

    // Text deltas — append to the LAST part if it's text, otherwise
    // start a new text part. Crucially, we do NOT look up by id —
    // AI SDK reuses the same text id across a whole message, so
    // matching by id would glue pre- and post-tool-call text together
    // (the original bug).
    if (type === "text-delta" || type === "text" || type === "text-start") {
      const delta =
        typeof event.delta === "string"
          ? event.delta
          : typeof event.text === "string"
            ? event.text
            : "";
      if (!delta && type !== "text-start") return;
      setStreamParts((parts) => {
        const last = parts[parts.length - 1];
        if (last?.kind === "text") {
          const next = [...parts];
          next[next.length - 1] = { ...last, text: last.text + delta };
          return next;
        }
        return [
          ...parts,
          { kind: "text", id: `text-${parts.length}`, text: delta },
        ];
      });
      return;
    }

    // Tool call appearing in the stream. Input may stream in piece by
    // piece (tool-input-delta), or arrive whole (tool-input-available /
    // tool-call). We just create-or-update the tool part by toolCallId.
    if (
      type === "tool-input-start" ||
      type === "tool-call-start" ||
      type === "tool-call" ||
      type === "tool-input-end" ||
      type === "tool-input-available"
    ) {
      const id = String(event.toolCallId ?? event.id ?? "");
      if (!id) return;
      const name = String(event.toolName ?? event.name ?? "tool");
      const input = event.input ?? event.args ?? undefined;
      setStreamParts((parts) => {
        const idx = parts.findIndex((p) => p.kind === "tool" && p.id === id);
        if (idx >= 0) {
          const existing = parts[idx] as Extract<StreamPart, { kind: "tool" }>;
          const next = [...parts];
          next[idx] = {
            ...existing,
            name,
            input: input === undefined ? existing.input : input,
          };
          return next;
        }
        return [
          ...parts,
          {
            kind: "tool",
            id,
            name,
            input: input ?? null,
            output: undefined,
            status: "running",
          },
        ];
      });
      return;
    }

    // Tool result.
    if (
      type === "tool-output-end" ||
      type === "tool-result" ||
      type === "tool-output-available"
    ) {
      const id = String(event.toolCallId ?? event.id ?? "");
      if (!id) return;
      const output = event.output ?? event.result ?? null;
      setStreamParts((parts) =>
        parts.map((p) =>
          p.kind === "tool" && p.id === id
            ? { ...p, output, status: "done" }
            : p,
        ),
      );
      return;
    }

    // Tool error (rare).
    if (type === "tool-error" || type === "error") {
      const id = String(event.toolCallId ?? event.id ?? "");
      if (!id) return;
      setStreamParts((parts) =>
        parts.map((p) =>
          p.kind === "tool" && p.id === id
            ? {
                ...p,
                output: event.error ?? event.message ?? null,
                status: "error",
              }
            : p,
        ),
      );
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;

    setPendingUserText(text);
    setStreamParts([]);
    setInput("");
    setPending(true);
    setError(null);

    try {
      const historyForApi = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content:
            typeof m.content_json === "string"
              ? m.content_json
              : parseContent(m.content_json)
                  .filter(
                    (p): p is { kind: "text"; text: string } =>
                      p.kind === "text",
                  )
                  .map((p) => p.text)
                  .join(""),
        }))
        // Drop messages whose collapsed text is empty. Assistant turns
        // that contained ONLY tool calls (and produced no spoken text)
        // would otherwise get sent as { content: "" } and Anthropic
        // rejects empty text content blocks. The model loses its
        // internal tool-call reasoning trace for those turns, but the
        // conversation flow stays coherent because the assistant's
        // subsequent text turn already incorporated the tool results.
        .filter((m) => m.content.trim().length > 0);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: convoId,
          messages: [...historyForApi, { role: "user", content: text }],
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || `Request failed (${res.status})`);
      }
      const newConvoId = res.headers.get("X-Conversation-Id");

      for await (const ev of readSseEvents(res.body)) {
        handleStreamEvent(ev);
      }

      // For a freshly-created conversation, update the URL silently —
      // window.history (not router.replace) avoids remounting ChatView
      // and wiping streamParts. The next browser refresh will land on
      // /chat/[id] cleanly because the URL is real.
      if (!convoId && newConvoId) {
        setConvoId(newConvoId);
        window.history.replaceState({}, "", `/chat/${newConvoId}`);
      }
      // Refresh the layout (sidebar conversations list) and the page
      // (pulls newly-persisted messages into initialMessages). ChatView
      // doesn't remount because its props don't change.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInput(text);
    } finally {
      setPending(false);
      // Don't clear pendingUserText / streamParts here — the useEffect
      // that watches initialMessages will clear them when router.refresh()
      // delivers the persisted history.
    }
  }

  const isEmpty =
    historyBlocks.length === 0 &&
    streamBlocks.length === 0 &&
    !pendingUserText &&
    !pending;

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-neutral-950">
      {/* Header – left-pad on mobile to clear the hamburger button */}
      <header className="border-b border-neutral-200 px-4 py-3 pl-14 text-sm text-neutral-500 md:px-6 md:pl-6 dark:border-neutral-800 dark:text-neutral-400">
        {title ?? (conversationId ? "Conversation" : "New chat")}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
          {isEmpty && (
            <div className="mt-24 text-center text-neutral-500">
              <p className="text-lg">What do you want to work on?</p>
              <p className="mt-2 text-sm">
                Configure your provider key in Settings, then start typing.
              </p>
            </div>
          )}

          <div className="space-y-6">
            {historyBlocks.map((b) => {
              if (b.kind === "user-text")
                return <UserBubble key={b.key} text={b.text} />;
              if (b.kind === "assistant-text")
                return <AssistantText key={b.key} text={b.text} />;
              return (
                <ToolStep
                  key={b.key}
                  name={b.name}
                  input={b.input}
                  output={b.output}
                  status={b.status}
                />
              );
            })}

            {pendingUserText && <UserBubble text={pendingUserText} />}

            {streamBlocks.map((b, i) => {
              const isLastTextBlock =
                b.kind === "assistant-text" &&
                i === streamBlocks.length - 1 &&
                pending;
              if (b.kind === "assistant-text") {
                return (
                  <AssistantText
                    key={b.key}
                    text={b.text}
                    streaming={isLastTextBlock}
                  />
                );
              }
              return (
                <ToolStep
                  key={b.key}
                  name={b.name}
                  input={b.input}
                  output={b.output}
                  status={b.status}
                />
              );
            })}

            {/* Show dots if streaming but no text/tool blocks yet. */}
            {pending && streamBlocks.length === 0 && (
              <div className="text-sm">
                <StreamingDots />
              </div>
            )}
          </div>

          {error && (
            <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <form
        onSubmit={send}
        className="border-t border-neutral-200 bg-white px-4 py-4 md:px-6 dark:border-neutral-800 dark:bg-neutral-950"
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
            className="flex-1 resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <button
            type="submit"
            disabled={pending || input.trim().length === 0}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
