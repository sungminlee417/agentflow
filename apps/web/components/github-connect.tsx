"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function GitHubConnect({
  connected,
  scopes,
}: {
  connected: boolean;
  scopes: string[];
}) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function disconnect() {
    if (!confirm("Disconnect GitHub? The agent will lose access to your repos."))
      return;
    setWorking(true);
    const res = await fetch("/api/oauth/github/disconnect", { method: "POST" });
    setWorking(false);
    if (res.ok) router.refresh();
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            GitHub
          </h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {connected
              ? `Connected · scopes: ${scopes.join(", ") || "(none)"}`
              : "Not connected"}
          </p>
        </div>
        {connected ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={working}
            className="text-xs text-neutral-500 transition hover:text-red-500 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-red-400"
          >
            Disconnect
          </button>
        ) : (
          <a
            href="/api/oauth/github/start"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Connect
          </a>
        )}
      </div>
    </div>
  );
}
