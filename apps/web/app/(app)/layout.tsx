import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

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
    <div className="grid min-h-screen grid-cols-[260px_1fr]">
      <Sidebar
        conversations={conversations ?? []}
        hasAnyKey={(keys ?? []).length > 0}
      />
      <main className="overflow-y-auto">{children}</main>
    </div>
  );
}
