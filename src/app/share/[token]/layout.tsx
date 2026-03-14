import { notFound } from "next/navigation";
import { validateShareToken } from "@/lib/actions/shares";
import { SharedViewProvider } from "@/components/shared-view-context";
import { ComparisonTrigger } from "@/components/comparison/comparison-trigger";
import { CommandPaletteProvider } from "@/components/ui/command-palette-provider";
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
    .select("display_name, theme, primary_currency")
    .eq("id", share.owner_id)
    .single();

  const ownerName = profile?.display_name || "Anonymous";

  // Check if viewer is logged in (for "My Portfolio" / "Track your own" CTA)
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <SharedViewProvider ownerName={ownerName} scope={share.scope} shareToken={token}>
      <CommandPaletteProvider primaryCurrency={profile?.primary_currency ?? "EUR"}>
        <ThemeSync profileTheme={profile?.theme ?? null} />
        <div className="min-h-screen bg-zinc-950 text-zinc-100">
          <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:top-4 focus:left-4 focus:px-4 focus:py-2 focus:bg-zinc-800 focus:text-zinc-100 focus:rounded-lg">Skip to content</a>
          <ComparisonTrigger
            token={token}
            scope={share.scope}
            ownerName={ownerName}
            isAuthenticated={!!user}
          >
            <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 overflow-x-hidden">
              {children}
            </main>
          </ComparisonTrigger>
        </div>
      </CommandPaletteProvider>
    </SharedViewProvider>
  );
}
