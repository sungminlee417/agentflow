"use client";

// OAuth connect button for a provider. agentflow uses one shared
// OAuth app per provider (registered server-side via env vars), so
// this surface is now just a tile: provider name, description, and a
// Connect button that kicks off the standard OAuth dance. The
// per-user "bring your own OAuth app" flow has been removed.

export function OAuthConnect({
  provider,
  label,
  description,
  credentialsConfigured,
  onBeforeConnect,
}: {
  provider: string;
  label: string;
  description?: string;
  hasExistingAccounts?: boolean;
  /** True when the server has env-var OAuth credentials for this
   *  provider. False = "oauth_app_not_configured" — show as disabled. */
  credentialsConfigured: boolean;
  credentialsLast4?: string | null;
  credentialsSource?: "user" | "env" | null;
  hint?: string;
  /** If provided, runs instead of navigating directly. Use to show a
   *  pre-connect explanation modal. */
  onBeforeConnect?: () => void;
}) {
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
              : `${label} is unavailable — the server isn't configured with this provider's OAuth credentials yet.`
          }
        >
          Connect
        </a>
      </div>
    </div>
  );
}
