"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";

// OAuth credentials form + Connect button. Each user supplies their own
// OAuth app's client_id + client_secret per provider — server env vars
// are used as a fallback (handled in getOAuthCredentials).
//
// Multi-account: this surface is now used to add NEW connections. The
// "connected" state per account lives in the parent (IntegrationsHub),
// which renders AccountCard rows separately. Disconnect happens
// per-account, not via this component.

const PROVIDER_LABELS: Record<string, { idLabel: string; secretLabel: string }> = {
  github: { idLabel: "Client ID", secretLabel: "Client Secret" },
  youtube: { idLabel: "Client ID", secretLabel: "Client Secret" },
  tiktok: { idLabel: "Client Key", secretLabel: "Client Secret" },
  instagram: { idLabel: "App ID", secretLabel: "App Secret" },
};

export function OAuthConnect({
  provider,
  label,
  description,
  hint,
  hasExistingAccounts,
  credentialsConfigured,
  credentialsLast4,
  credentialsSource,
  onBeforeConnect,
}: {
  provider: string;
  label: string;
  description?: string;
  hint?: string;
  hasExistingAccounts: boolean;
  credentialsConfigured: boolean;
  credentialsLast4: string | null;
  credentialsSource: "user" | "env" | null;
  /** If provided, runs instead of navigating directly. Use to show a
   *  pre-connect explanation modal. */
  onBeforeConnect?: () => void;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [showCredsForm, setShowCredsForm] = useState(
    !credentialsConfigured && !hasExistingAccounts,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credStatus, setCredStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [credError, setCredError] = useState<string | null>(null);

  const labels = PROVIDER_LABELS[provider] ?? {
    idLabel: "Client ID",
    secretLabel: "Client Secret",
  };

  async function saveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredStatus("saving");
    setCredError(null);
    const res = await fetch("/api/oauth-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      setCredStatus("error");
      setCredError((await res.text()) || "Failed to save");
      return;
    }
    setClientId("");
    setClientSecret("");
    setCredStatus("saved");
    setShowCredsForm(false);
    router.refresh();
    setTimeout(() => setCredStatus("idle"), 1500);
  }

  async function deleteCredentials() {
    const ok = await confirm({
      title: `Remove your saved ${label} OAuth app credentials?`,
      description:
        "Existing connections keep working until you disconnect them.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const res = await fetch(`/api/oauth-credentials?provider=${provider}`, {
      method: "DELETE",
    });
    if (res.ok) router.refresh();
  }

  const canConnect = credentialsConfigured;

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {label}
          </h3>
          {description && (
            <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
          )}
        </div>
        <a
          href={canConnect && !onBeforeConnect ? `/api/oauth/${provider}/start` : undefined}
          onClick={(e) => {
            if (!canConnect) {
              e.preventDefault();
              return;
            }
            if (onBeforeConnect) {
              e.preventDefault();
              onBeforeConnect();
            }
          }}
          aria-disabled={!canConnect}
          className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition ${
            canConnect
              ? "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
              : "cursor-not-allowed bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500"
          }`}
          title={
            canConnect
              ? `Connect ${label}`
              : `Configure your OAuth app credentials first`
          }
        >
          Connect
        </a>
      </div>

      <div className="mt-3 border-t border-neutral-100 pt-3 dark:border-neutral-800/60">
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="text-neutral-500">
            <span className="font-medium">OAuth app:</span>{" "}
            {credentialsConfigured ? (
              <span>
                {credentialsSource === "user"
                  ? `your saved app${credentialsLast4 ? ` · ends in ${credentialsLast4}` : ""}`
                  : "using server fallback (env vars)"}
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                not configured — paste your OAuth app credentials below
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {credentialsSource === "user" && (
              <button
                type="button"
                onClick={deleteCredentials}
                className="text-neutral-500 transition hover:text-red-500 dark:hover:text-red-400"
              >
                Remove
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowCredsForm((s) => !s)}
              className="text-neutral-500 transition hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              {showCredsForm
                ? "Hide"
                : credentialsConfigured
                  ? "Replace"
                  : "Set up"}
            </button>
          </div>
        </div>

        {hint && (
          <p className="mt-1 text-[11px] text-neutral-500 italic">{hint}</p>
        )}

        {showCredsForm && (
          <form onSubmit={saveCredentials} className="mt-3 space-y-2">
            <input
              type="text"
              autoComplete="off"
              placeholder={labels.idLabel}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <input
              type="password"
              autoComplete="off"
              placeholder={labels.secretLabel}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              required
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <button
              type="submit"
              disabled={
                credStatus === "saving" ||
                clientId.length === 0 ||
                clientSecret.length === 0
              }
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-neutral-900 px-4 py-2 text-xs font-medium text-white transition hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
            >
              {credStatus === "saving" && (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              )}
              {credStatus === "saved" && (
                <Check className="h-3 w-3" aria-hidden="true" />
              )}
              {credStatus === "saving"
                ? "Saving"
                : credStatus === "saved"
                  ? "Saved"
                  : credentialsConfigured
                    ? "Replace credentials"
                    : "Save credentials"}
            </button>
            {credError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {credError}
              </p>
            )}
          </form>
        )}
      </div>
      {dialog}
    </div>
  );
}
