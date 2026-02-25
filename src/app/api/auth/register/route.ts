import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  try {
    const { code, email, password } = await req.json();

    if (!code || !email || !password) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const admin = createAdminClient();

    // 1. Validate invite code (bypasses RLS)
    const { data: invite, error: inviteError } = await admin
      .from("invite_codes")
      .select("*")
      .eq("code", code.trim())
      .is("used_by", null)
      .single();

    if (inviteError || !invite) {
      return NextResponse.json(
        { error: "Invalid or already used invite code" },
        { status: 400 }
      );
    }

    // Check expiry
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return NextResponse.json(
        { error: "This invite code has expired" },
        { status: 400 }
      );
    }

    // 2. Create the user via admin API
    const { data: userData, error: signUpError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (signUpError) {
      return NextResponse.json(
        { error: signUpError.message },
        { status: 400 }
      );
    }

    // 3. Mark invite as used
    if (userData.user) {
      await admin
        .from("invite_codes")
        .update({
          used_by: userData.user.id,
          used_at: new Date().toISOString(),
        })
        .eq("id", invite.id);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[register] Unhandled error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
