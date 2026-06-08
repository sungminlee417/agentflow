"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Account profile form — display name (saved into Supabase Auth user
// metadata so it survives across devices) + password change. Email
// changes go through Supabase's confirm-email flow, which is a bit
// more involved; we expose it as read-only here.

export function ProfileForm({
  email,
  initialDisplayName,
}: {
  email: string | null;
  initialDisplayName: string | null;
}) {
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [savingName, setSavingName] = useState(false);

  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [savingPwd, setSavingPwd] = useState(false);

  async function saveDisplayName(e: React.FormEvent) {
    e.preventDefault();
    if (savingName) return;
    setSavingName(true);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({
      data: { display_name: displayName.trim() },
    });
    setSavingName(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Display name updated.");
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (savingPwd) return;
    if (newPwd.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (newPwd !== confirmPwd) {
      toast.error("Passwords don't match.");
      return;
    }
    setSavingPwd(true);
    const supabase = createSupabaseBrowserClient();
    // Re-authenticate by signing in with the current password first.
    // Supabase doesn't require this for updateUser — it just uses the
    // active session — but verifying the current password protects
    // against an unattended-laptop attack where someone hits Settings
    // and changes the password silently.
    if (email && currentPwd) {
      const { error: signinErr } = await supabase.auth.signInWithPassword({
        email,
        password: currentPwd,
      });
      if (signinErr) {
        setSavingPwd(false);
        toast.error("Current password is wrong.");
        return;
      }
    }
    const { error } = await supabase.auth.updateUser({ password: newPwd });
    setSavingPwd(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setCurrentPwd("");
    setNewPwd("");
    setConfirmPwd("");
    toast.success("Password changed. Keep it safe.");
  }

  return (
    <div className="space-y-8">
      <form onSubmit={saveDisplayName} className="space-y-3">
        <div>
          <label
            htmlFor="email"
            className="block text-xs font-medium text-neutral-500"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email ?? ""}
            readOnly
            className="mt-1 w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label
            htmlFor="display_name"
            className="block text-xs font-medium text-neutral-500"
          >
            Display name
          </label>
          <input
            id="display_name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="What should we call you?"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
        <button
          type="submit"
          disabled={savingName || displayName.trim() === (initialDisplayName ?? "")}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {savingName ? "Saving…" : "Save profile"}
        </button>
      </form>

      <form onSubmit={changePassword} className="space-y-3">
        <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Change password
        </h3>
        <div>
          <label
            htmlFor="current_pwd"
            className="block text-xs font-medium text-neutral-500"
          >
            Current password
          </label>
          <input
            id="current_pwd"
            type="password"
            value={currentPwd}
            onChange={(e) => setCurrentPwd(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
        <div>
          <label
            htmlFor="new_pwd"
            className="block text-xs font-medium text-neutral-500"
          >
            New password
          </label>
          <input
            id="new_pwd"
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
        <div>
          <label
            htmlFor="confirm_pwd"
            className="block text-xs font-medium text-neutral-500"
          >
            Confirm new password
          </label>
          <input
            id="confirm_pwd"
            type="password"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
        <button
          type="submit"
          disabled={savingPwd || !newPwd || !confirmPwd}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {savingPwd ? "Updating…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
