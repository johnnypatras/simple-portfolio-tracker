import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  try {
    const { code, email, password, first_name, last_name } = await req.json();

    if (!email || !password) {
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
    const hasCode = typeof code === "string" && code.trim().length > 0;
    let inviteId: string | null = null;

    // 1. If invite code provided, validate it
    if (hasCode) {
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

      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        return NextResponse.json(
          { error: "This invite code has expired" },
          { status: 400 }
        );
      }

      inviteId = invite.id;
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

    if (userData.user) {
      // Save optional name fields
      const nameFields: Record<string, string> = {};
      if (typeof first_name === "string" && first_name.trim())
        nameFields.first_name = first_name.trim();
      if (typeof last_name === "string" && last_name.trim())
        nameFields.last_name = last_name.trim();

      if (hasCode && inviteId) {
        // 3a. Mark invite as used — user is auto-approved (status stays 'active')
        await admin
          .from("invite_codes")
          .update({
            used_by: userData.user.id,
            used_at: new Date().toISOString(),
          })
          .eq("id", inviteId);

        // Save names if provided
        if (Object.keys(nameFields).length > 0) {
          await admin
            .from("profiles")
            .update(nameFields)
            .eq("id", userData.user.id);
        }
      } else {
        // 3b. No invite code — set profile to pending (+ save names)
        await admin
          .from("profiles")
          .update({ status: "pending", ...nameFields })
          .eq("id", userData.user.id);
      }
    }

    return NextResponse.json({
      success: true,
      pending: !hasCode,
    });
  } catch (err) {
    console.error("[register] Unhandled error:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
