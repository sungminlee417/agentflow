"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";

// Per-account constraints/preferences the agent must respect when
// generating + evaluating ideas. Free-form text, e.g.:
//
//   "Don't suggest gym filming yet — not comfortable there."
//   "Prefer outdoor / golden-hour lighting."
//   "No talking head — keep my face out of frame."
//
// Collapsed by default; opens to a textarea + save. Saved indicator
// fades out so it doesn't linger.

export function AccountPreferences({
  selectedAccountId,
  initial,
}: {
  selectedAccountId: string | null;
  initial: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Sync local state when the active account or server value changes.
  useEffect(() => {
    setValue(initial ?? "");
    setStatus("idle");
    setError(null);
  }, [initial, selectedAccountId]);

  // Fade the "Saved" indicator out after a moment.
  useEffect(() => {
    if (status !== "saved") return;
    const t = setTimeout(() => setStatus("idle"), 1500);
    return () => clearTimeout(t);
  }, [status]);

  async function save() {
    if (!selectedAccountId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/video-ideas/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration_id: selectedAccountId,
          preferences: value.trim() ? value.trim() : null,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setStatus("error");
        setError(text.slice(0, 200) || `Save failed (${res.status}).`);
        return;
      }
      setStatus("saved");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const hasValue = !!(initial && initial.trim());

  return (
    <div className="rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:hover:bg-neutral-900"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal
            className="h-3.5 w-3.5 text-neutral-500"
            aria-hidden="true"
          />
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            Preferences for this account
          </span>
          {hasValue && !open && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <span className="h-1 w-1 rounded-full bg-emerald-500" />
              set
            </span>
          )}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
          <p className="text-[11px] text-neutral-500">
            Free-form constraints the agent will respect when generating + evaluating ideas.
            Example: <em>&ldquo;Don&apos;t suggest gym filming yet — not comfortable
            there. Prefer home / outdoor scenes.&rdquo;</em>
          </p>
          <textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (status === "saved") setStatus("idle");
            }}
            placeholder="One per line is fine. Talk to the agent like you would a video editor who keeps making the same mistake."
            rows={4}
            disabled={saving}
            className="mt-2 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-neutral-500">
              {status === "saved" && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  ✓ Saved
                </span>
              )}
              {status === "error" && error && (
                <span className="text-red-600 dark:text-red-400">{error}</span>
              )}
            </span>
            <button
              type="button"
              onClick={save}
              disabled={saving || !selectedAccountId}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
            >
              {saving ? "Saving…" : "Save preferences"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
