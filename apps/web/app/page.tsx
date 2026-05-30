import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight">agentflow</h1>
      <p className="mt-3 text-neutral-400">
        Background Claude agents that analyze content and run domain-specific
        workflows.
      </p>

      <section className="mt-12 grid gap-4 sm:grid-cols-2">
        <Link
          href="/jobs"
          className="rounded-lg border border-neutral-800 p-5 transition hover:border-neutral-600"
        >
          <h2 className="font-medium">Jobs</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Run and review agent jobs.
          </p>
        </Link>
        <Link
          href="/integrations"
          className="rounded-lg border border-neutral-800 p-5 transition hover:border-neutral-600"
        >
          <h2 className="font-medium">Integrations</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Connect YouTube and other accounts.
          </p>
        </Link>
      </section>
    </main>
  );
}
