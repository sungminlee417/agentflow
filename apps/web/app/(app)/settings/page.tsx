import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PROVIDERS } from "@/lib/ai-providers";
import { ApiKeyForm } from "@/components/api-key-form";

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, key_last4, updated_at");

  const keysByProvider = new Map(
    (keys ?? []).map((k) => [k.provider as string, k]),
  );

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-10">
        <h2 className="text-lg font-medium">AI provider keys</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Bring your own keys — they're encrypted at rest and used only to
          forward your messages to the provider you select.
        </p>

        <div className="mt-6 space-y-4">
          {PROVIDERS.map((p) => {
            const existing = keysByProvider.get(p.name);
            return (
              <ApiKeyForm
                key={p.name}
                provider={p.name}
                label={p.label}
                keyHint={p.keyHint}
                existingLast4={existing?.key_last4 ?? null}
              />
            );
          })}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-medium">Integrations</h2>
        <p className="mt-1 text-sm text-neutral-400">
          OAuth connections (YouTube, GitHub, TikTok, Instagram) will live
          here. Coming soon.
        </p>
      </section>
    </div>
  );
}
