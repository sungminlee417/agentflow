"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { OAuthConnect } from "@/components/oauth-connect";
import { ServiceKeyForm } from "@/components/service-key-form";
import { AnalyticsUpload, type UploadRow } from "@/components/analytics-upload";

export type IntegrationAddon = {
  service: "apify";
  label: string;
  description: string;
  hint?: string;
  keyHint: string;
  unlocksDescription?: string;
  configured: boolean;
  keyLast4: string | null;
};

export type ConnectedAccount = {
  id: string;
  handle: string | null;
  displayName: string | null;
  accountLabel: string | null;
  providerAccountId: string;
  scopes: string[];
};

export type ProviderGroup = {
  provider: "github" | "youtube" | "tiktok" | "instagram";
  label: string;
  group: "code" | "social";
  description: string;
  hint?: string;
  accounts: ConnectedAccount[];
  credentialsConfigured: boolean;
  credentialsLast4: string | null;
  credentialsSource: "user" | "env" | null;
  uploads?: UploadRow[];
  uploadHint?: { label: string; description: string };
  addons?: IntegrationAddon[];
};

type Status = "connected" | "configured" | "unconfigured";

function statusFor(p: ProviderGroup): Status {
  if (p.accounts.length > 0) return "connected";
  if (p.credentialsConfigured) return "configured";
  return "unconfigured";
}

function accountTitle(a: ConnectedAccount): string {
  if (a.accountLabel) return a.accountLabel;
  if (a.displayName && a.handle) return `${a.displayName} (@${a.handle})`;
  if (a.displayName) return a.displayName;
  if (a.handle) return `@${a.handle}`;
  return `Account ${a.providerAccountId.slice(0, 8)}…`;
}

function StatusPill({ status, count }: { status: Status; count: number }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {count} connected
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
  p,
  onConfigure,
}: {
  p: ProviderGroup;
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
            {p.label}
          </span>
          <StatusPill status={statusFor(p)} count={p.accounts.length} />
        </div>
        <p className="mt-1 text-xs text-neutral-500">{p.description}</p>
        {p.accounts.length > 0 && (
          <p className="mt-1 truncate text-xs text-neutral-600 dark:text-neutral-400">
            {p.accounts.map((a) => accountTitle(a)).join(" · ")}
          </p>
        )}
      </div>
      <span className="shrink-0 text-xs text-neutral-500">Configure →</span>
    </button>
  );
}

function AccountCard({
  provider,
  account,
}: {
  provider: ProviderGroup["provider"];
  account: ConnectedAccount;
}) {
  const router = useRouter();
  const [editingLabel, setEditingLabel] = useState(false);
  const [label, setLabel] = useState(account.accountLabel ?? "");
  const [working, setWorking] = useState(false);

  async function saveLabel() {
    setWorking(true);
    const res = await fetch(`/api/integrations/${account.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_label: label || null }),
    });
    setWorking(false);
    if (res.ok) {
      setEditingLabel(false);
      router.refresh();
    }
  }

  async function disconnect() {
    if (
      !confirm(`Disconnect ${accountTitle(account)}? The agent will lose access.`)
    )
      return;
    setWorking(true);
    const res = await fetch(
      `/api/oauth/${provider}/disconnect?integration_id=${account.id}`,
      { method: "POST" },
    );
    setWorking(false);
    if (res.ok) router.refresh();
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {editingLabel ? (
            <div className="flex items-center gap-2">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Nickname (e.g. 'Guitar channel')"
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                onClick={saveLabel}
                disabled={working}
                className="text-xs text-neutral-700 underline hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-300 dark:hover:text-neutral-100"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditingLabel(false);
                  setLabel(account.accountLabel ?? "");
                }}
                className="text-xs text-neutral-500"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h4 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {accountTitle(account)}
              </h4>
              <button
                type="button"
                onClick={() => setEditingLabel(true)}
                className="text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                Rename
              </button>
            </div>
          )}
          <p className="mt-0.5 text-[11px] text-neutral-500">
            {account.providerAccountId === "legacy"
              ? "Legacy connection — reconnect to enable per-account features"
              : `scopes: ${account.scopes.join(", ") || "(none)"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={disconnect}
          disabled={working}
          className="shrink-0 text-xs text-neutral-500 transition hover:text-red-500 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-red-400"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

export function IntegrationsHub({
  providers,
}: {
  providers: ProviderGroup[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  const codeProviders = providers.filter((i) => i.group === "code");
  const socialProviders = providers.filter((i) => i.group === "social");

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Integrations
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Connect one or more accounts per platform. Each account can be
          renamed and used independently in Video Ideas. OAuth app credentials
          and add-ons (Apify, uploads) live in each provider's modal.
        </p>
      </header>

      {codeProviders.length > 0 && (
        <section className="mt-10">
          <GroupLabel>Code</GroupLabel>
          <div className="space-y-3">
            {codeProviders.map((p) => (
              <Row
                key={p.provider}
                p={p}
                onConfigure={() => setOpen(p.provider)}
              />
            ))}
          </div>
        </section>
      )}

      {socialProviders.length > 0 && (
        <section className="mt-10">
          <GroupLabel>Social media</GroupLabel>
          <div className="space-y-3">
            {socialProviders.map((p) => (
              <Row
                key={p.provider}
                p={p}
                onConfigure={() => setOpen(p.provider)}
              />
            ))}
          </div>
        </section>
      )}

      {providers.map((p) => (
        <Modal
          key={p.provider}
          open={open === p.provider}
          onClose={() => setOpen(null)}
          title={p.label}
          subtitle={p.description}
        >
          <div className="space-y-6">
            {p.accounts.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  Connected accounts
                </h3>
                <div className="space-y-2">
                  {p.accounts.map((a) => (
                    <AccountCard
                      key={a.id}
                      provider={p.provider}
                      account={a}
                    />
                  ))}
                </div>
              </div>
            )}

            <OAuthConnect
              provider={p.provider}
              label={
                p.accounts.length > 0 ? `Add another ${p.label} account` : p.label
              }
              description={
                p.accounts.length > 0
                  ? "To switch which account is connected, sign out of the current account in your browser first, then click Connect."
                  : p.description
              }
              hint={p.hint}
              hasExistingAccounts={p.accounts.length > 0}
              credentialsConfigured={p.credentialsConfigured}
              credentialsLast4={p.credentialsLast4}
              credentialsSource={p.credentialsSource}
            />

            {p.group === "social" && p.uploadHint && (
              <div>
                <h3 className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                  Analytics uploads
                </h3>
                <AnalyticsUpload
                  provider={p.provider as "youtube" | "tiktok" | "instagram"}
                  label={p.uploadHint.label}
                  description={p.uploadHint.description}
                  uploads={p.uploads ?? []}
                />
              </div>
            )}

            {(p.addons ?? []).map((addon) => (
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
