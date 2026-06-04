"use client";

import { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const supabase = createSupabaseBrowserClient();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "resending" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const FOCUS_RING =
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500";

  async function sendMagicLink(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setStatus(status === "sent" ? "resending" : "sending");
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
    <main className="grid min-h-screen place-items-center bg-neutral-50 px-4 py-10 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm sm:p-8 dark:border-neutral-800 dark:bg-neutral-950 dark:shadow-xl">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-neutral-900 text-sm font-bold text-white dark:bg-white dark:text-black">
            a
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            agentflow
          </h1>
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          Sign in to your workspace.
        </p>

        <button
          type="button"
          onClick={signInWithGoogle}
          className={`mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 ${FOCUS_RING} dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800`}
        >
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wider text-neutral-400">
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          or
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </div>

        {status === "sent" || status === "resending" ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <div className="flex items-center gap-2 font-medium">
                <Mail className="h-4 w-4" aria-hidden="true" />
                Check your inbox
              </div>
              <p className="mt-1 text-xs">
                We sent a sign-in link to{" "}
                <span className="font-medium">{email}</span>. It expires in 1
                hour.
              </p>
            </div>
            <p className="text-xs text-neutral-500">
              Didn&apos;t see it? Check spam, or{" "}
              <button
                type="button"
                onClick={() => sendMagicLink()}
                disabled={status === "resending"}
                className={`font-medium text-neutral-700 underline transition hover:text-neutral-900 disabled:opacity-50 ${FOCUS_RING} dark:text-neutral-300 dark:hover:text-neutral-100`}
              >
                {status === "resending" ? "sending…" : "send another"}
              </button>
              .
            </p>
            <button
              type="button"
              onClick={() => {
                setStatus("idle");
                setError(null);
              }}
              className={`text-xs text-neutral-500 underline transition hover:text-neutral-700 ${FOCUS_RING} dark:hover:text-neutral-300`}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={sendMagicLink} className="space-y-3">
            <div>
              <label
                htmlFor="login-email"
                className="block text-xs font-medium text-neutral-700 dark:text-neutral-300"
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={`mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none ${FOCUS_RING} dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500`}
              />
            </div>
            <button
              type="submit"
              disabled={status === "sending" || email.length === 0}
              className={`flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-60 ${FOCUS_RING} dark:bg-white dark:text-black dark:hover:bg-neutral-200`}
            >
              {status === "sending" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
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
