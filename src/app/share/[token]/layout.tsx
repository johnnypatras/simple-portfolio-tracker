import { notFound } from "next/navigation";
import { validateShareToken } from "@/lib/actions/shares";
import { SharedViewProvider } from "@/components/shared-view-context";
import { ComparisonTrigger } from "@/components/comparison/comparison-trigger";
import { ThemeSync } from "@/components/theme-sync";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ReactNode } from "react";

interface Props {
  params: Promise<{ token: string }>;
  children: ReactNode;
}

export default async function ShareLayout({ params, children }: Props) {
  const { token } = await params;

  // Validate the share token
  const share = await validateShareToken(token);
  if (!share) notFound();

  // Fetch owner's display name + theme (never expose email to shared viewers)
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("display_name, theme")
    .eq("id", share.owner_id)
    .single();

  const ownerName = profile?.display_name || "Anonymous";

  // Check if viewer is logged in (for "My Portfolio" / "Track your own" CTA)
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <SharedViewProvider ownerName={ownerName} scope={share.scope} shareToken={token}>
      <ThemeSync profileTheme={profile?.theme ?? null} />
      <div className="min-h-screen bg-zinc-950 text-zinc-100">
        <ComparisonTrigger
          token={token}
          scope={share.scope}
          ownerName={ownerName}
          isAuthenticated={!!user}
        >
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 overflow-x-hidden">
            {children}
          </main>
        </ComparisonTrigger>
      </div>
    </SharedViewProvider>
  );
}
