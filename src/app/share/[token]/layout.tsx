import { notFound } from "next/navigation";
import { validateShareToken } from "@/lib/actions/shares";
import { SharedViewProvider } from "@/components/shared-view-context";
import { SharedNavBar } from "@/components/shared-nav-bar";
import { createAdminClient } from "@/lib/supabase/admin";
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

  // Fetch owner's display name
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("display_name, email")
    .eq("id", share.owner_id)
    .single();

  const ownerName = profile?.display_name || profile?.email || "Anonymous";

  return (
    <SharedViewProvider ownerName={ownerName} scope={share.scope} shareToken={token}>
      <div className="min-h-screen bg-zinc-950 text-zinc-100">
        <SharedNavBar token={token} scope={share.scope} ownerName={ownerName} />
        <main className="max-w-7xl mx-auto px-4 py-6">
          {children}
        </main>
      </div>
    </SharedViewProvider>
  );
}
