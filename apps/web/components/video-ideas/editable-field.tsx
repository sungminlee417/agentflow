"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

// Inline editable text field for the video-ideas detail modal.
//
// UX:
//   - Click anywhere on the rendered value → swap to <textarea>/input.
//   - Edit, then blur (or hit Cmd/Ctrl-Enter / Escape) to commit/cancel.
//   - On commit with a real change, calls onSave (PATCH wrapper).
//   - Shows "Saved" pulse on success; surfaces errors via toast.
//   - Optional ✨ button on the right opens a polish popover that asks
//     the AI for alternatives; clicking one applies it (via onSave).
//
// Multi-line vs single-line is a `multiline` prop. The textarea
// auto-grows to its content; the single-line input is just <input>.
//
// We deliberately don't validate beyond "non-empty when required" —
// the server PATCH does the substantive-change diff before logging.

type Alternative = { label: string; value: string };

export function EditableField({
  value,
  placeholder = "Add…",
  multiline = false,
  monospace = false,
  required = false,
  saveLabel = "Save",
  onSave,
  polish,
}: {
  value: string | null;
  placeholder?: string;
  multiline?: boolean;
  monospace?: boolean;
  required?: boolean;
  saveLabel?: string;
  /** Called on commit when the value substantively changed. Throws
   *  surface as toast errors; resolve = "Saved" pulse + collapse. */
  onSave: (next: string) => Promise<void>;
  /** Optional AI polish: returns alternatives the user can pick from. */
  polish?: {
    label: string;
    fetchAlternatives: (current: string) => Promise<Alternative[]>;
  };
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value ?? "");
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset draft if the underlying value changes upstream (e.g. polish
  // applied or another tab edited).
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  // Autofocus + autogrow when entering edit mode.
  useEffect(() => {
    if (!editing) return;
    if (multiline) {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    } else {
      inputRef.current?.focus();
    }
  }, [editing, multiline]);

  async function commit(next: string) {
    if (required && next.trim().length === 0) {
      toast.error("Can't be empty");
      return;
    }
    if (next === (value ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setShowSaved(true);
      window.setTimeout(() => setShowSaved(false), 1500);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-1.5">
        {multiline ? (
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const ta = e.target as HTMLTextAreaElement;
              ta.style.height = "auto";
              ta.style.height = `${ta.scrollHeight}px`;
            }}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(value ?? "");
                setEditing(false);
              }
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === "Enter"
              ) {
                e.preventDefault();
                commit(draft);
              }
            }}
            className={`w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 ${monospace ? "font-mono text-xs" : ""}`}
            placeholder={placeholder}
            disabled={saving}
            rows={multiline ? 4 : 1}
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(value ?? "");
                setEditing(false);
              }
              if (e.key === "Enter") {
                e.preventDefault();
                commit(draft);
              }
            }}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            placeholder={placeholder}
            disabled={saving}
          />
        )}
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span>
            {multiline ? "⌘/Ctrl + Enter to save · " : "Enter to save · "}
            Esc to cancel
          </span>
          {saving && <span>Saving…</span>}
        </div>
      </div>
    );
  }

  const isEmpty = !value || value.trim().length === 0;
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to edit"
        className={`block w-full cursor-text rounded-md px-3 py-2 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
          isEmpty
            ? "text-neutral-400 italic"
            : "text-neutral-800 dark:text-neutral-200"
        } ${monospace ? "font-mono whitespace-pre-wrap text-xs" : multiline ? "whitespace-pre-wrap" : ""}`}
      >
        {isEmpty ? placeholder : value}
      </button>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
        {polish && (
          <PolishButton
            label={polish.label}
            currentValue={value ?? ""}
            fetchAlternatives={polish.fetchAlternatives}
            onPick={(picked) => commit(picked)}
          />
        )}
        {showSaved && (
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            Saved
          </span>
        )}
      </div>
      <span className="sr-only">{saveLabel}</span>
    </div>
  );
}

function PolishButton({
  label,
  currentValue,
  fetchAlternatives,
  onPick,
}: {
  label: string;
  currentValue: string;
  fetchAlternatives: (current: string) => Promise<Alternative[]>;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [alts, setAlts] = useState<Alternative[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function summon() {
    setOpen(true);
    if (alts.length > 0) return; // cached for this session
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAlternatives(currentValue);
      setAlts(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch alternatives");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          summon();
        }}
        title={`✨ ${label}`}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-violet-700 ring-1 ring-violet-200 transition hover:bg-violet-50 dark:bg-neutral-900 dark:text-violet-300 dark:ring-violet-900/40 dark:hover:bg-violet-950/30"
      >
        <Sparkles className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-7 z-50 w-80 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
            <div className="mb-1.5 flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                ✨ {label}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[11px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                Close
              </button>
            </div>
            {loading && (
              <div className="px-2 py-3 text-xs text-neutral-500">Thinking…</div>
            )}
            {error && (
              <div className="px-2 py-2 text-xs text-rose-700 dark:text-rose-300">
                {error}
              </div>
            )}
            {!loading && !error && alts.length === 0 && (
              <div className="px-2 py-3 text-xs text-neutral-500">
                No alternatives returned.
              </div>
            )}
            <div className="space-y-1">
              {alts.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(a.value);
                    setOpen(false);
                  }}
                  className="block w-full rounded-md px-2 py-2 text-left text-xs text-neutral-800 transition hover:bg-violet-50 dark:text-neutral-200 dark:hover:bg-violet-950/30"
                >
                  <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
                    {a.label}
                  </div>
                  <div className="whitespace-pre-wrap">{a.value}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
