import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PROVIDERS } from "@agentflow/core";
import { ApiKeyForm } from "@/components/api-key-form";

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, key_last4, model, updated_at");

  const keysByProvider = new Map(
    (keys ?? []).map((k) => [k.provider as string, k]),
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-6">
      {/* Left-pad title on mobile to clear the hamburger button */}
      <h1 className="pl-10 text-2xl font-semibold tracking-tight text-neutral-900 md:pl-0 dark:text-neutral-100">
        Settings
      </h1>

      <section className="mt-10">
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
    </div>
  );
}
