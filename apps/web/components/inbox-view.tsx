"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Inbox as InboxIcon,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { PROVIDER_LABELS } from "@/components/video-ideas/constants";
import { providerChipClass } from "@/components/video-ideas/helpers";

// /inbox — draft-and-approve comment replies across connected social
// accounts. Each card shows the original comment + AI-drafted reply;
// the user can edit, send, or dismiss.
//
// Pull model: manual button at top ("Pull comments"). Calls the
// /api/inbox/pull route which fetches recent comments from every
// supported integration (IG + YT today; TT awaiting app review) and
// generates AI drafts in parallel.

export type InboxAccount = {
  id: string;
  provider: string;
  handle: string | null;
  displayName: string | null;
  accountLabel: string | null;
  providerAccountId: string;
};

export type ReplyRow = {
  id: string;
  integration_id: string;
  platform: string;
  source_comment_id: string;
  source_author: string | null;
  source_text: string;
  source_video_id: string;
  source_video_url: string | null;
  source_video_title: string | null;
  source_posted_at: string | null;
  draft_text: string | null;
  status: "draft" | "sent" | "dismissed" | "failed";
  send_error: string | null;
  sent_at: string | null;
  created_at: string;
};

function accountLabel(a: InboxAccount): string {
  if (a.accountLabel) return a.accountLabel;
  if (a.displayName && a.handle) return `${a.displayName} (@${a.handle})`;
  if (a.displayName) return a.displayName;
  if (a.handle) return `@${a.handle}`;
  return `Account ${a.providerAccountId.slice(0, 8)}…`;
}

export function InboxView({
  accounts,
  replies,
}: {
  accounts: InboxAccount[];
  replies: ReplyRow[];
}) {
  const router = useRouter();
  const [pulling, setPulling] = useState(false);
  const [filterAccountId, setFilterAccountId] = useState<string | null>(null);
  const [view, setView] = useState<"draft" | "sent" | "dismissed">("draft");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);

  const accountById = useMemo(() => {
    const m = new Map<string, InboxAccount>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  const replies_byId = useMemo(() => {
    const m = new Map<string, ReplyRow>();
    for (const r of replies) m.set(r.id, r);
    return m;
  }, [replies]);

  const baseForView = useMemo(() => {
    if (view === "draft") return replies.filter((r) => r.status === "draft" || r.status === "failed");
    if (view === "sent") return replies.filter((r) => r.status === "sent");
    return replies.filter((r) => r.status === "dismissed");
  }, [replies, view]);

  const visible = useMemo(() => {
    if (!filterAccountId) return baseForView;
    return baseForView.filter((r) => r.integration_id === filterAccountId);
  }, [baseForView, filterAccountId]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) m.set(a.id, 0);
    for (const r of baseForView) {
      m.set(r.integration_id, (m.get(r.integration_id) ?? 0) + 1);
    }
    return m;
  }, [accounts, baseForView]);

  async function pullComments() {
    if (pulling || accounts.length === 0) return;
    setPulling(true);
    try {
      const res = await fetch("/api/inbox/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        toast.error(`Pull failed: ${await res.text()}`);
        return;
      }
      const json = (await res.json()) as {
        pulled?: number;
        skipped?: Array<{ label: string; reason: string }>;
        errors?: Array<{ label: string; message: string }>;
      };
      // Surface skipped + error accounts BEFORE the summary so the
      // user knows TT-was-silently-dropped instead of seeing the
      // misleading "all caught up" toast.
      if (json.skipped && json.skipped.length > 0) {
        for (const s of json.skipped) {
          toast(`${s.label} skipped — ${s.reason}`, { duration: 8000 });
        }
      }
      if (json.errors && json.errors.length > 0) {
        for (const e of json.errors) {
          toast.error(`${e.label}: ${e.message}`, { duration: 10000 });
        }
      }
      if ((json.pulled ?? 0) === 0) {
        if (!(json.skipped?.length || json.errors?.length)) {
          toast.success("No new comments — you're all caught up.");
        }
      } else {
        toast.success(
          `Pulled ${json.pulled} new comment${json.pulled === 1 ? "" : "s"}.`,
        );
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pull failed");
    } finally {
      setPulling(false);
    }
  }

  async function send(id: string) {
    setSendingId(id);
    const draft = edits[id];
    try {
      // If user edited, persist before sending.
      if (draft !== undefined) {
        await fetch(`/api/inbox/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft_text: draft }),
        });
      }
      const res = await fetch(`/api/inbox/${id}/send`, { method: "POST" });
      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(errJson.error ?? "Send failed");
        router.refresh();
        return;
      }
      toast.success("Reply posted.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendingId(null);
    }
  }

  // TikTok-specific: copy the reply to clipboard and mark sent. We can't
  // auto-post via API until TT app-review grants the comment.create
  // scope; in the meantime the user pastes it manually in the TT app.
  async function copyAndMarkSent(id: string) {
    setSendingId(id);
    const draft = edits[id];
    try {
      if (draft !== undefined) {
        await fetch(`/api/inbox/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft_text: draft }),
        });
      }
      const replies = replies_byId.get(id);
      const textToCopy = draft ?? replies?.draft_text ?? "";
      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch {
        toast.error("Couldn't copy to clipboard — copy manually.");
      }
      const res = await fetch(`/api/inbox/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "sent" }),
      });
      if (!res.ok) {
        toast.error(`Mark-sent failed: ${await res.text()}`);
        router.refresh();
        return;
      }
      toast.success("Copied. Paste in TikTok and you're done.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Copy failed");
    } finally {
      setSendingId(null);
    }
  }

  async function dismiss(id: string) {
    try {
      await fetch(`/api/inbox/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dismiss failed");
    }
  }

  async function remove(id: string) {
    try {
      await fetch(`/api/inbox/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700">
          <InboxIcon
            className="mx-auto mb-4 h-10 w-10 text-neutral-400"
            aria-hidden="true"
          />
          <h2 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
            Connect an account to manage your inbox
          </h2>
          <p className="mt-2 text-sm text-neutral-500">
            Once you connect Instagram or YouTube, the inbox pulls
            recent comments on your videos and drafts replies for you
            to review.
          </p>
          <a
            href="/integrations"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Connect an account →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Inbox
        </h1>
        <button
          type="button"
          onClick={pullComments}
          disabled={pulling}
          className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${pulling ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {pulling ? "Pulling…" : "Pull comments"}
        </button>
      </header>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {accounts.map((a) => {
          const count = counts.get(a.id) ?? 0;
          const active = filterAccountId === a.id;
          const chipClass = providerChipClass(a.provider);
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setFilterAccountId(active ? null : a.id)}
              title={accountLabel(a)}
              className={`group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-2 ring-inset transition ${
                active
                  ? "ring-neutral-900 dark:ring-neutral-100"
                  : "ring-transparent hover:brightness-95 dark:hover:brightness-110"
              } ${chipClass}`}
            >
              <span className="font-semibold uppercase tracking-wide">
                {PROVIDER_LABELS[a.provider] ?? a.provider}
              </span>
              <span className="opacity-75">{accountLabel(a)}</span>
              <span className="rounded-full bg-white/60 px-1.5 text-[10px] font-semibold tabular-nums text-neutral-900 dark:bg-black/30 dark:text-neutral-100">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-100/60 p-1 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
        {(["draft", "sent", "dismissed"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`flex-1 rounded-md px-2 py-1 font-medium transition ${
              view === v
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            {v === "draft"
              ? "Drafts"
              : v === "sent"
                ? "Sent"
                : "Dismissed"}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {visible.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {view === "draft"
              ? 'No drafts. Hit "Pull comments" to fetch the latest.'
              : view === "sent"
                ? "No sent replies yet."
                : "No dismissed comments."}
          </div>
        )}
        {visible.map((r) => (
          <ReplyCard
            key={r.id}
            r={r}
            account={accountById.get(r.integration_id) ?? null}
            edited={edits[r.id]}
            onEdit={(text) => setEdits((e) => ({ ...e, [r.id]: text }))}
            onSend={() =>
              r.platform === "tiktok"
                ? copyAndMarkSent(r.id)
                : send(r.id)
            }
            onDismiss={() => dismiss(r.id)}
            onDelete={() => remove(r.id)}
            sending={sendingId === r.id}
          />
        ))}
      </div>
    </div>
  );
}

function ReplyCard({
  r,
  account,
  edited,
  onEdit,
  onSend,
  onDismiss,
  onDelete,
  sending,
}: {
  r: ReplyRow;
  account: InboxAccount | null;
  edited: string | undefined;
  onEdit: (text: string) => void;
  onSend: () => void;
  onDismiss: () => void;
  onDelete: () => void;
  sending: boolean;
}) {
  const text = edited ?? r.draft_text ?? "";
  const platform = r.platform.toLowerCase();
  const platformLabel = PROVIDER_LABELS[platform] ?? platform;
  const chipClass = providerChipClass(platform);

  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${chipClass}`}
          title={account ? accountLabel(account) : ""}
        >
          {platformLabel}
        </span>
        {account && (
          <span className="text-neutral-500">{accountLabel(account)}</span>
        )}
        {r.source_video_title && (
          <span className="truncate text-neutral-500" title={r.source_video_title}>
            · {r.source_video_title}
          </span>
        )}
        {r.source_video_url && (
          <a
            href={r.source_video_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            title="Open original post"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>

      <div className="mt-2 rounded-md bg-neutral-50 px-3 py-2 dark:bg-neutral-900">
        <div className="text-[11px] font-medium text-neutral-500">
          @{r.source_author ?? "viewer"}
        </div>
        <p className="mt-0.5 text-sm whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">
          {r.source_text}
        </p>
      </div>

      {r.status === "draft" || r.status === "failed" ? (
        <>
          <div className="mt-3">
            <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              AI draft (edit before sending)
            </label>
            <textarea
              value={text}
              onChange={(e) => onEdit(e.target.value)}
              placeholder="Write a reply…"
              rows={2}
              className="mt-1 w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
          {r.status === "failed" && r.send_error && (
            <p className="mt-2 text-[11px] text-rose-700 dark:text-rose-300">
              Send failed: {r.send_error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <X className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Dismiss
            </button>
            {r.platform === "tiktok" ? (
              <button
                type="button"
                onClick={onSend}
                disabled={sending || text.trim().length === 0}
                title="TikTok doesn't allow auto-replies yet — this copies your reply to the clipboard so you can paste it in the app."
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
              >
                <Clipboard className="h-3 w-3" aria-hidden="true" />
                {sending ? "Copying…" : "Copy & mark sent"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={sending || text.trim().length === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
              >
                <Send className="h-3 w-3" aria-hidden="true" />
                {sending ? "Sending…" : "Send"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 dark:bg-emerald-950/30">
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400"
              aria-hidden="true"
            />
            <div className="flex-1 text-sm">
              <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                {r.status === "sent"
                  ? `Sent ${r.sent_at ? new Date(r.sent_at).toLocaleString() : ""}`
                  : "Dismissed"}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-emerald-900 dark:text-emerald-200">
                {r.draft_text}
              </p>
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-rose-700 dark:hover:text-rose-300"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Remove from history
            </button>
          </div>
        </>
      )}
    </article>
  );
}
