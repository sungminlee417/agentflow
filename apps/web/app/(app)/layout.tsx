import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const [{ data: keys }, { data: userData }] = await Promise.all([
    supabase.from("user_api_keys").select("provider"),
    supabase.auth.getUser(),
  ]);

  return (
    <AppShell
      userEmail={userData.user?.email ?? null}
      hasAnyKey={(keys ?? []).length > 0}
    >
      {children}
    </AppShell>
  );
}
