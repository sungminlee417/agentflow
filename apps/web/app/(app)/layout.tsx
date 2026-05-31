import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();

  const [{ data: conversations }, { data: keys }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false })
      .limit(50),
    supabase.from("user_api_keys").select("provider"),
  ]);

  return (
    <AppShell
      conversations={conversations ?? []}
      hasAnyKey={(keys ?? []).length > 0}
    >
      {children}
    </AppShell>
  );
}
