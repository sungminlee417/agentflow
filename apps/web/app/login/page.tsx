"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const supabase = createSupabaseBrowserClient();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setStatus("error");
      setError(error.message);
    } else {
      setStatus("sent");
    }
  }

  async function signInWithGoogle() {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) setError(error.message);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-neutral-50 px-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 dark:shadow-xl">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          agentflow
        </h1>
        <p className="mt-1 text-sm text-neutral-500">Sign in to continue.</p>

        <button
          onClick={signInWithGoogle}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          Continue with Google
        </button>

        <div className="my-6 flex items-center gap-3 text-xs text-neutral-500">
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          or
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </div>

        {status === "sent" ? (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            Check {email} for a sign-in link.
          </p>
        ) : (
          <form onSubmit={sendMagicLink} className="space-y-3">
            <label className="block text-sm">
              <span className="text-neutral-700 dark:text-neutral-300">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
            </label>
            <button
              type="submit"
              disabled={status === "sending"}
              className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
            >
              {status === "sending" ? "Sending…" : "Send magic link"}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </main>
  );
}
