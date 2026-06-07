import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Public landing for unauthenticated visitors. Once signed in we
// short-circuit straight to /video-ideas so this page never gets
// in the way for return users.

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/video-ideas");

  return (
    <main className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-base font-semibold tracking-tight">
          agentflow
        </span>
        <Link
          href="/login"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          Sign in
        </Link>
      </header>

      <section className="mx-auto max-w-3xl px-6 pb-16 pt-12 sm:pt-20">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          Shoot-ready video ideas,
          <br className="hidden sm:inline" />
          grounded in <span className="text-fuchsia-600 dark:text-fuchsia-400">your</span>{" "}
          audience.
        </h1>
        <p className="mt-5 max-w-2xl text-base text-neutral-600 dark:text-neutral-400 sm:text-lg">
          Connect your TikTok, YouTube, or Instagram and agentflow reads
          your top performers, scans the niche for what&apos;s breaking
          out, and writes a beat-by-beat script you can record from. Mark
          posted videos and it pulls stats + writes a post-mortem at 48h
          and 7 days — feeding the next batch of ideas with what actually
          worked.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Get started →
          </Link>
          <span className="text-xs text-neutral-500">
            Connect TikTok, YouTube, or Instagram. Free during beta.
          </span>
        </div>

        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          <ValueProp
            title="Grounded in your data"
            body="Ideas are derived from your actual top performers and your current niche — not generic LLM brain-dumps. Every idea cites the tool result it came from."
          />
          <ValueProp
            title="Shoot-ready scripts"
            body="Each card has labeled time-stamped beats with the exact spoken line, on-screen text, camera action, and audio cue. Pick up the phone and roll."
          />
          <ValueProp
            title="Closed learning loop"
            body="Mark posted videos and agentflow pulls stats at 48h and 7d, writes a post-mortem, and folds the learnings into the next batch. Thumbs-down what doesn't fit so the next refresh gets sharper."
          />
        </div>
      </section>

      <footer className="mx-auto max-w-5xl border-t border-neutral-200 px-6 py-8 text-xs text-neutral-500 dark:border-neutral-800">
        <p>Personal project · open source on GitHub.</p>
      </footer>
    </main>
  );
}

function ValueProp({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {title}
      </h3>
      <p className="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
        {body}
      </p>
    </div>
  );
}
