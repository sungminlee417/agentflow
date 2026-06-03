"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Quick-add idea inbox.
//
// User types a raw spark ("what if I do left-handed guitars?"), hits
// Evaluate, and the AI returns one of three verdicts:
//   • add → already inserted into the library, jump to it
//   • needs_work → show the reframing inline; user can iterate or
//     accept the partial draft
//   • pass → explain why, user can dismiss or rephrase

type Verdict = "add" | "needs_work" | "pass";

type EvalResponse = {
  verdict?: Verdict;
  reasoning?: string;
  added_id?: string;
  error?: string;
};

const VERDICT_COPY: Record<Verdict, { label: string; color: string }> = {
  add: {
    label: "✓ Added to your ideas",
    color:
      "bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-200",
  },
  needs_work: {
    label: "↻ Needs work",
    color:
      "bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-200",
  },
  pass: {
    label: "✗ Pass",
    color:
      "bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950/40 dark:border-rose-900 dark:text-rose-200",
  },
};

export function QuickAddIdea({
  selectedAccountId,
}: {
  selectedAccountId: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [result, setResult] = useState<EvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function evaluate() {
    if (!selectedAccountId) {
      setError("Pick an account above first.");
      return;
    }
    if (!text.trim()) return;
    setEvaluating(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/video-ideas/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration_id: selectedAccountId,
          text: text.trim(),
          add_if_good: true,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as EvalResponse;
      if (!res.ok) {
        setError(json.error ?? `Evaluation failed (${res.status}).`);
        return;
      }
      setResult(json);
      if (json.verdict === "add" && json.added_id) {
        // Idea was inserted — pull the fresh list in.
        router.refresh();
        setText("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEvaluating(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-start gap-2">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (result) setResult(null);
          }}
          placeholder="Got an idea? Type the spark — I'll evaluate it against your audience and add it if it fits."
          rows={2}
          disabled={evaluating}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void evaluate();
            }
          }}
          className="flex-1 resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          type="button"
          onClick={evaluate}
          disabled={evaluating || !text.trim() || !selectedAccountId}
          className="shrink-0 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {evaluating ? "Evaluating…" : "Evaluate"}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {result?.verdict && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${VERDICT_COPY[result.verdict].color}`}
        >
          <div className="text-xs font-semibold">
            {VERDICT_COPY[result.verdict].label}
          </div>
          {result.reasoning && (
            <p className="mt-1 text-xs leading-relaxed opacity-90">
              {result.reasoning}
            </p>
          )}
          {result.verdict === "add" && result.added_id && (
            <p className="mt-1.5 text-[11px] opacity-70">
              Scroll down — the new idea is at the top of your list.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
