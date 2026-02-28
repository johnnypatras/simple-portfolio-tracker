import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  // Pages that don't require authentication
  const isAuthPage =
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/register") ||
    request.nextUrl.pathname.startsWith("/forgot-password") ||
    request.nextUrl.pathname.startsWith("/reset-password") ||
    request.nextUrl.pathname.startsWith("/auth/callback");

  // Share links are always accessible, regardless of auth state
  const isSharePage = request.nextUrl.pathname.startsWith("/share");

  // Skip Supabase calls entirely for public pages — avoids a network
  // round-trip to Supabase on every request, which was the primary
  // cause of 6-7s TTFB on /login and /share routes.
  if (isAuthPage || isSharePage) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the session — this is critical for keeping auth alive
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPendingPage = request.nextUrl.pathname.startsWith("/pending");

  // Redirect unauthenticated users to login
  if (!user && !isPendingPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // For authenticated users, check profile status
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("status")
      .eq("id", user.id)
      .single();

    const isPending = profile?.status === "pending";

    // Pending users can only see /pending — redirect everywhere else
    if (isPending && !isPendingPage) {
      const url = request.nextUrl.clone();
      url.pathname = "/pending";
      return NextResponse.redirect(url);
    }

    // Active/admin users on /pending → send to dashboard
    if (!isPending && isPendingPage) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
