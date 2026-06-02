"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";

export function ServiceKeyForm({
  service,
  label,
  description,
  hint,
  keyHint,
  existingLast4,
}: {
  service: string;
  label: string;
  description: string;
  hint?: string;
  keyHint: string;
  existingLast4: string | null;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    const res = await fetch("/api/service-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, key: value }),
    });
    if (!res.ok) {
      setStatus("error");
      setError((await res.text()) || "Failed to save");
      return;
    }
    setValue("");
    setStatus("saved");
    router.refresh();
    setTimeout(() => setStatus("idle"), 1500);
  }

  async function remove() {
    if (!existingLast4) return;
    const ok = await confirm({
      title: `Remove your ${label} key?`,
      description: "You can paste a new one any time.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const res = await fetch(`/api/service-keys?service=${service}`, {
      method: "DELETE",
    });
    if (res.ok) router.refresh();
  }

  return (
    <form
      onSubmit={save}
      className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {label}
          </h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {existingLast4
              ? `Configured · ends in ${existingLast4}`
              : description}
          </p>
        </div>
        {existingLast4 && (
          <button
            type="button"
            onClick={remove}
            className="text-xs text-neutral-500 transition hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400"
          >
            Remove
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          placeholder={keyHint}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={status === "saving" || value.length === 0}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {status === "saving"
            ? "Saving…"
            : status === "saved"
              ? "Saved"
              : existingLast4
                ? "Replace"
                : "Save"}
        </button>
      </div>

      {hint && !existingLast4 && (
        <p className="mt-2 text-xs text-neutral-500 italic">{hint}</p>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {dialog}
    </form>
  );
}
