import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar email={user.email ?? ""} />
      <main className="flex-1 lg:ml-0">
        <div className="max-w-7xl mx-auto pl-14 pr-4 sm:px-6 lg:px-8 pt-16 pb-8 lg:py-8 overflow-x-hidden">
          {children}
        </div>
      </main>
    </div>
  );
}
