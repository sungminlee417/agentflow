"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleDashed, CircleSlash } from "lucide-react";
import { Modal } from "@/components/modal";
import { OAuthConnect } from "@/components/oauth-connect";
import { ServiceKeyForm } from "@/components/service-key-form";
import { AnalyticsUpload, type UploadRow } from "@/components/analytics-upload";
import { useConfirm } from "@/components/confirm-dialog";

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
  // Icon + color so colorblind users can still distinguish states.
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        {count} connected
      </span>
    );
  }
  if (status === "configured") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
        <CircleDashed className="h-3 w-3" aria-hidden="true" />
        Not connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
      <CircleSlash className="h-3 w-3" aria-hidden="true" />
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
  const { confirm, dialog } = useConfirm();

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
    const ok = await confirm({
      title: `Disconnect ${accountTitle(account)}?`,
      description:
        "The agent will lose access to this account. Video ideas linked to it stay until they expire.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
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
          className="shrink-0 rounded text-xs text-neutral-500 transition hover:text-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-red-400"
        >
          Disconnect
        </button>
      </div>
      {dialog}
    </div>
  );
}

export type ConnectResult = {
  provider: string;
  action: "created" | "updated";
  handle: string | null;
};

function ConnectResultBanner({
  result,
  providers,
}: {
  result: ConnectResult;
  providers: ProviderGroup[];
}) {
  const providerGroup = providers.find((p) => p.provider === result.provider);
  const label = providerGroup?.label ?? result.provider;
  const handleStr = result.handle ? `@${result.handle}` : "your account";
  // "updated" + the provider already had >1 connected accounts means a
  // genuine token refresh (reconnecting to update scopes). "updated"
  // when the user has only this one account but TRIED to add another
  // is the duplicate-account failure mode — same banner is good enough
  // since we can't tell intent.
  const accountsCount = providerGroup?.accounts.length ?? 0;
  const isDuplicate = result.action === "updated" && accountsCount >= 1;

  if (result.action === "created") {
    return (
      <div className="mb-6 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
        <strong>Connected {handleStr}.</strong> A new {label} account is now
        available in Video Ideas.
      </div>
    );
  }

  if (isDuplicate && result.provider === "tiktok") {
    return (
      <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <p>
          <strong>Already connected as {handleStr}.</strong> TikTok signed you in
          with the same account you already have. TikTok doesn&apos;t offer an
          in-app account picker, so to add a different account:
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
          <li>
            Open{" "}
            <a
              href="https://www.tiktok.com/logout"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              tiktok.com/logout
            </a>{" "}
            in a new tab to sign out fully.
          </li>
          <li>
            Sign in to TikTok as the account you want to add. An Incognito
            window is the safest way to keep your sessions separate.
          </li>
          <li>Come back here and click Connect again.</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-md border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <strong>Refreshed {handleStr}.</strong> Token updated for this {label}{" "}
      account.
    </div>
  );
}

function PreConnectTikTokModal({
  open,
  onClose,
  onContinue,
  hasExistingAccounts,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
  hasExistingAccounts: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preconnect-tiktok-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
      >
        <h3
          id="preconnect-tiktok-title"
          className="text-base font-semibold text-neutral-900 dark:text-neutral-100"
        >
          Before connecting TikTok
        </h3>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          TikTok will connect whichever account is currently signed in on{" "}
          <span className="font-medium">tiktok.com</span> in this browser. There
          is no account picker.
        </p>
        {hasExistingAccounts && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            To add a <em>different</em> account from the one(s) you already
            have, make sure that account is the one signed in on tiktok.com
            right now. The easiest way is to use an Incognito / Private window
            signed in only as that account.
          </p>
        )}
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-neutral-500">
          <li>
            Open{" "}
            <a
              href="https://www.tiktok.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              tiktok.com
            </a>{" "}
            in a new tab. Confirm the avatar in the top-right matches the
            account you want to connect.
          </li>
          <li>
            If wrong, sign out and back in as the correct account (or use an
            Incognito window).
          </li>
          <li>Return here and continue.</li>
        </ol>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Continue to TikTok
          </button>
        </div>
      </div>
    </div>
  );
}

export function IntegrationsHub({
  providers,
  connectResult,
  errorParam,
}: {
  providers: ProviderGroup[];
  connectResult?: ConnectResult | null;
  errorParam?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [tiktokModalOpen, setTiktokModalOpen] = useState(false);

  const codeProviders = providers.filter((i) => i.group === "code");
  const socialProviders = providers.filter((i) => i.group === "social");

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:py-10">
      <header className="pl-10 md:pl-0">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Integrations
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Connect one or more accounts per platform. Each account can be
          renamed and used independently in Video Ideas.
        </p>
      </header>

      {errorParam && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <strong>Connection failed:</strong> {errorParam}
        </div>
      )}
      {connectResult && !errorParam && (
        <div className="mt-6">
          <ConnectResultBanner result={connectResult} providers={providers} />
        </div>
      )}

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

      <PreConnectTikTokModal
        open={tiktokModalOpen}
        onClose={() => setTiktokModalOpen(false)}
        onContinue={() => {
          setTiktokModalOpen(false);
          window.location.href = "/api/oauth/tiktok/start";
        }}
        hasExistingAccounts={
          (providers.find((p) => p.provider === "tiktok")?.accounts.length ?? 0) >
          0
        }
      />

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
                  ? p.provider === "tiktok"
                    ? "TikTok has no account picker — you'll connect whichever account is currently signed in on tiktok.com. Click Connect to see a quick checklist."
                    : "To switch which account is connected, sign out of the current account in your browser first, then click Connect."
                  : p.description
              }
              hint={p.hint}
              hasExistingAccounts={p.accounts.length > 0}
              credentialsConfigured={p.credentialsConfigured}
              credentialsLast4={p.credentialsLast4}
              credentialsSource={p.credentialsSource}
              onBeforeConnect={
                p.provider === "tiktok"
                  ? () => setTiktokModalOpen(true)
                  : undefined
              }
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
