"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { AccountPreferences } from "@/components/account-preferences";
import { QuickAddIdea } from "@/components/quick-add-idea";
import { PROVIDER_LABELS } from "../constants";
import { accountTitle, providerChipClass } from "../helpers";
import type { AccountGroup } from "../types";

// Per-account settings modal. One section per connected integration,
// each with: target_count input (top up to N ideas), preferences
// textarea (free-text guidance fed to the agent prompt), and a
// quick-add input ("I have an idea: …"). Reuses the existing
// AccountPreferences + QuickAddIdea components so behavior stays
// consistent with what users saw on the per-account page pre-flat.
export function AccountSettingsModal({
  open,
  groups,
  onClose,
}: {
  open: boolean;
  groups: AccountGroup[];
  onClose: () => void;
}) {
  // Local mirror of target_count per account, so the stepper feels
  // snappy. Saves on blur / Enter.
  const [targets, setTargets] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.account.id, g.targetCount);
    return m;
  });
  useEffect(() => {
    setTargets(() => {
      const m = new Map<string, number>();
      for (const g of groups) m.set(g.account.id, g.targetCount);
      return m;
    });
  }, [groups]);

  async function saveTarget(accountId: string, value: number) {
    const clamped = Math.max(1, Math.min(50, Math.round(value)));
    setTargets((prev) => {
      const next = new Map(prev);
      next.set(accountId, clamped);
      return next;
    });
    await fetch("/api/video-ideas/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        integration_id: accountId,
        target_count: clamped,
      }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      subtitle="Per-account targets, preferences, and quick-add ideas"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-6">
        {groups.map((g) => {
          const acct = g.account;
          const target = targets.get(acct.id) ?? g.targetCount;
          const chipClass = providerChipClass(acct.provider);
          return (
            <details
              key={acct.id}
              open={groups.length === 1}
              className="rounded-lg border border-neutral-200 dark:border-neutral-800"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chipClass}`}
                >
                  {PROVIDER_LABELS[acct.provider] ?? acct.provider}
                </span>
                <span className="truncate">{accountTitle(acct)}</span>
              </summary>
              <div className="space-y-4 border-t border-neutral-200 px-3 py-4 dark:border-neutral-800">
                <div>
                  <label className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-neutral-700 dark:text-neutral-300">
                      Target ideas
                      <span className="ml-1 text-neutral-500">
                        — Refresh fills up to this many pending ideas
                      </span>
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={target}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) {
                          setTargets((prev) => {
                            const next = new Map(prev);
                            next.set(acct.id, n);
                            return next;
                          });
                        }
                      }}
                      onBlur={(e) => saveTarget(acct.id, Number(e.target.value))}
                      className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-right text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    />
                  </label>
                </div>
                <AccountPreferences
                  selectedAccountId={acct.id}
                  initial={g.preferences}
                />
                <QuickAddIdea selectedAccountId={acct.id} />
              </div>
            </details>
          );
        })}
      </div>
    </Modal>
  );
}
