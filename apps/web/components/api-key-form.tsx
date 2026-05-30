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
      className="rounded-lg border border-neutral-800 bg-neutral-950 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{label}</h3>
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
            className="text-xs text-neutral-400 transition hover:text-red-400"
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
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={status === "saving" || value.length === 0}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:opacity-50"
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

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </form>
  );
}
