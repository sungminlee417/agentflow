"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ApiKeyForm({
  provider,
  label,
  keyHint,
  existingLast4,
}: {
  provider: string;
  label: string;
  keyHint: string;
  existingLast4: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, key: value }),
    });
    if (!res.ok) {
      const text = await res.text();
      setStatus("error");
      setError(text || "Failed to save");
      return;
    }
    setValue("");
    setStatus("saved");
    router.refresh();
    setTimeout(() => setStatus("idle"), 1500);
  }

  async function remove() {
    if (!existingLast4) return;
    if (!confirm(`Remove your ${label} key?`)) return;
    const res = await fetch(`/api/api-keys?provider=${provider}`, {
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
              : "Not configured"}
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
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
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

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </form>
  );
}
