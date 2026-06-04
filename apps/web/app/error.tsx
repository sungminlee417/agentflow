"use client";

import { useEffect } from "react";
import Link from "next/link";

// Global error boundary. Anything that throws in a server or client
// component (not caught lower in the tree) lands here.
//
// We don't surface the raw error message in production — it can leak
// internal details. In dev the digest is enough to grep the server
// logs for the full stack.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The framework already logs the full stack server-side. Client
    // sees the digest only.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[error boundary]", error);
    }
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-6 dark:bg-neutral-950">
      <div className="max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wider text-rose-600 dark:text-rose-400">
          Something went wrong
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          We hit an unexpected error.
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          Try the action again. If it keeps happening, head back to a known-good
          page.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[10px] text-neutral-400">
            ref: {error.digest}
          </p>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Try again
          </button>
          <Link
            href="/video-ideas"
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Video ideas
          </Link>
        </div>
      </div>
    </div>
  );
}
