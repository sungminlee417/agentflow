import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-6 dark:bg-neutral-950">
      <div className="max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          404
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          The link might be broken, or the page might have moved.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <Link
            href="/video-ideas"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Go to Video ideas
          </Link>
        </div>
      </div>
    </div>
  );
}
