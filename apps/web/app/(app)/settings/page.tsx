import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PROVIDERS } from "@agentflow/core";
import { ApiKeyForm } from "@/components/api-key-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { ProfileForm } from "@/components/profile-form";

export const metadata: Metadata = {
  title: "Account & settings",
};

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const [{ data: keys }, { data: userData }] = await Promise.all([
    supabase
      .from("user_api_keys")
      .select("provider, key_last4, model, updated_at"),
    supabase.auth.getUser(),
  ]);

  const keysByProvider = new Map(
    (keys ?? []).map((k) => [k.provider as string, k]),
  );

  const displayName =
    (userData.user?.user_metadata?.display_name as string | undefined) ?? null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
        Account &amp; settings
      </h1>

      <section className="mt-8" id="profile">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          Profile
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Your display name appears in chats and team views (later).
        </p>
        <div className="mt-4">
          <ProfileForm
            email={userData.user?.email ?? null}
            initialDisplayName={displayName}
          />
        </div>
      </section>

      <section className="mt-10" id="ai-keys">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          AI provider keys
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Your keys are encrypted and sent directly to the AI provider — never
          stored in plaintext, never shared.
        </p>
        <div className="mt-6 space-y-4">
          {PROVIDERS.map((p) => {
            const existing = keysByProvider.get(p.name) as
              | { key_last4: string; model: string | null }
              | undefined;
            return (
              <ApiKeyForm
                key={p.name}
                provider={p.name}
                label={p.label}
                keyHint={p.keyHint}
                existingLast4={existing?.key_last4 ?? null}
                existingModel={existing?.model ?? null}
              />
            );
          })}
        </div>
      </section>

      <section className="mt-10" id="theme">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          Appearance
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Auto follows your system setting.
        </p>
        <div className="mt-4">
          <ThemeToggle />
        </div>
      </section>
    </div>
  );
}
