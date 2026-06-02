"use client";

import { useState } from "react";
import { Modal } from "@/components/modal";
import { OAuthConnect } from "@/components/oauth-connect";
import { ServiceKeyForm } from "@/components/service-key-form";
import { AnalyticsUpload, type UploadRow } from "@/components/analytics-upload";

type Status = "connected" | "configured" | "unconfigured";

// Inline addon — a service the user can optionally configure to enhance
// a specific OAuth integration. Currently only Apify (which enhances
// TikTok with trend search + transcription source).
export type IntegrationAddon = {
  service: "apify";
  label: string;
  description: string;
  hint?: string;
  keyHint: string;
  /** Markdown-ish description of which tools this unlocks once set */
  unlocksDescription?: string;
  configured: boolean;
  keyLast4: string | null;
};

export type OAuthIntegration = {
  provider: "github" | "youtube" | "tiktok" | "instagram";
  label: string;
  group: "code" | "social";
  description: string;
  hint?: string;
  connected: boolean;
  scopes: string[];
  credentialsConfigured: boolean;
  credentialsLast4: string | null;
  credentialsSource: "user" | "env" | null;
  /** Only for social: uploads under this provider */
  uploads?: UploadRow[];
  /** Only for social: human-readable upload card description */
  uploadHint?: { label: string; description: string };
  /** Optional service addons to render inside this integration's modal */
  addons?: IntegrationAddon[];
};

function statusForOAuth(i: OAuthIntegration): Status {
  if (i.connected) return "connected";
  if (i.credentialsConfigured) return "configured";
  return "unconfigured";
}

function StatusPill({ status }: { status: Status }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Connected
      </span>
    );
  }
  if (status === "configured") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Not connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
      Not configured
    </span>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
      {children}
    </h2>
  );
}

function Row({
  label,
  status,
  description,
  onConfigure,
}: {
  label: string;
  status: Status;
  description: string;
  onConfigure: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onConfigure}
      className="flex w-full items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-left transition hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-700 dark:hover:bg-neutral-900"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {label}
          </span>
          <StatusPill status={status} />
        </div>
        <p className="mt-1 text-xs text-neutral-500">{description}</p>
      </div>
      <span className="shrink-0 text-xs text-neutral-500">Configure →</span>
    </button>
  );
}

export function IntegrationsHub({
  oauth,
}: {
  oauth: OAuthIntegration[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  const codeOAuth = oauth.filter((i) => i.group === "code");
  const socialOAuth = oauth.filter((i) => i.group === "social");

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Integrations
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Connect your accounts, paste OAuth app credentials, and upload
          analytics exports. Each integration's full configuration — including
          any optional service keys (e.g. Apify for TikTok) — lives in its own
          modal. Click any row.
        </p>
      </header>

      {codeOAuth.length > 0 && (
        <section className="mt-10">
          <GroupLabel>Code</GroupLabel>
          <div className="space-y-3">
            {codeOAuth.map((i) => (
              <Row
                key={i.provider}
                label={i.label}
                status={statusForOAuth(i)}
                description={i.description}
                onConfigure={() => setOpen(i.provider)}
              />
            ))}
          </div>
        </section>
      )}

      {socialOAuth.length > 0 && (
        <section className="mt-10">
          <GroupLabel>Social media</GroupLabel>
          <div className="space-y-3">
            {socialOAuth.map((i) => (
              <Row
                key={i.provider}
                label={i.label}
                status={statusForOAuth(i)}
                description={i.description}
                onConfigure={() => setOpen(i.provider)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Integration modals ──────────────────────────────────────── */}
      {oauth.map((i) => (
        <Modal
          key={i.provider}
          open={open === i.provider}
          onClose={() => setOpen(null)}
          title={i.label}
          subtitle={i.description}
        >
          <div className="space-y-6">
            <OAuthConnect
              provider={i.provider}
              label={i.label}
              description={i.description}
              hint={i.hint}
              connected={i.connected}
              scopes={i.scopes}
              credentialsConfigured={i.credentialsConfigured}
              credentialsLast4={i.credentialsLast4}
              credentialsSource={i.credentialsSource}
            />

            {i.group === "social" && i.uploadHint && (
              <div>
                <h3 className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  Analytics uploads
                </h3>
                <AnalyticsUpload
                  provider={i.provider as "youtube" | "tiktok" | "instagram"}
                  label={i.uploadHint.label}
                  description={i.uploadHint.description}
                  uploads={i.uploads ?? []}
                />
              </div>
            )}

            {(i.addons ?? []).map((addon) => (
              <div key={addon.service}>
                <h3 className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  Add-on: {addon.label}
                </h3>
                <ServiceKeyForm
                  service={addon.service}
                  label={addon.label}
                  description={addon.description}
                  hint={addon.hint}
                  keyHint={addon.keyHint}
                  existingLast4={addon.keyLast4}
                />
                {addon.unlocksDescription && (
                  <p className="mt-2 text-[11px] text-neutral-500">
                    {addon.unlocksDescription}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Modal>
      ))}
    </div>
  );
}
