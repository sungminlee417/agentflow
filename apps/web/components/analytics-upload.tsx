"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";

export type UploadRow = {
  id: string;
  provider: string;
  label: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  created_at: string;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function AnalyticsUpload({
  provider,
  label,
  description,
  uploads,
}: {
  provider: "tiktok" | "youtube" | "instagram";
  label: string;
  description: string;
  uploads: UploadRow[];
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("provider", provider);
    if (customLabel) form.set("label", customLabel);
    const res = await fetch("/api/uploads/creator-analytics", {
      method: "POST",
      body: form,
    });
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    setCustomLabel("");
    if (!res.ok) {
      setError((await res.text()) || "Upload failed");
      return;
    }
    router.refresh();
  }

  async function removeUpload(id: string) {
    const ok = await confirm({
      title: "Delete this upload?",
      description: "The agent will no longer have this data to draw from.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await fetch(`/api/uploads/creator-analytics?id=${id}`, {
      method: "DELETE",
    });
    if (res.ok) router.refresh();
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div>
        <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {label}
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          placeholder='Optional label (e.g. "Per-video stats August")'
          value={customLabel}
          onChange={(e) => setCustomLabel(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.json,.txt,text/csv,text/plain,application/json"
          onChange={onPick}
          disabled={uploading}
          className="hidden"
          id={`upload-${provider}`}
        />
        <label
          htmlFor={`upload-${provider}`}
          className="cursor-pointer rounded-md bg-neutral-900 px-4 py-2 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {uploading ? "Uploading…" : "Upload CSV/JSON"}
        </label>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {uploads.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-neutral-200 pt-3 text-xs dark:border-neutral-800">
          {uploads.map((u) => (
            <li
              key={u.id}
              className="flex items-center justify-between gap-2 text-neutral-600 dark:text-neutral-400"
            >
              <span className="truncate">
                {u.label}
                <span className="ml-2 text-neutral-500">
                  · {formatBytes(u.size_bytes)} ·{" "}
                  {new Date(u.created_at).toLocaleDateString()}
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeUpload(u.id)}
                className="text-neutral-400 transition hover:text-red-500 dark:hover:text-red-400"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </div>
  );
}
