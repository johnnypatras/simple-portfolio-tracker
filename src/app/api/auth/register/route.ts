import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import type { Database } from "@/types/database";

const limiter = rateLimit({ windowMs: 60_000, max: 5 });

export async function POST(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  try {
    const { code, email, password, display_name, first_name, last_name } = await req.json();

    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    // Validate name field lengths
    if (typeof display_name === "string" && display_name.trim().length > 100) {
      return NextResponse.json({ error: "Display name too long (max 100)" }, { status: 400 });
    }
    if (typeof first_name === "string" && first_name.trim().length > 100) {
      return NextResponse.json({ error: "First name too long (max 100)" }, { status: 400 });
    }
    if (typeof last_name === "string" && last_name.trim().length > 100) {
      return NextResponse.json({ error: "Last name too long (max 100)" }, { status: 400 });
    }

    if (password.length < 8 || password.length > 72) {
      return NextResponse.json(
        { error: password.length < 8 ? "Password must be at least 8 characters" : "Password must be at most 72 characters" },
        { status: 400 }
      );
    }

    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return NextResponse.json(
        { error: "Password must include uppercase, lowercase, and a number" },
        { status: 400 }
      );
    }

    const admin = createAdminClient();
    const hasCode = typeof code === "string" && code.trim().length > 0;
    let inviteId: string | null = null;

    // 1. If invite code provided, validate it exists and is available
    if (hasCode) {
      const trimmedCode = code.trim();
      if (trimmedCode.length > 64) {
        return NextResponse.json(
          { error: "Invalid or already used invite code" },
          { status: 400 }
        );
      }
      const { data: invite, error: inviteError } = await admin
        .from("invite_codes")
        .select("id, expires_at")
        .eq("code", trimmedCode)
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
        email: trimmedEmail,
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
      const nameFields: Database["public"]["Tables"]["profiles"]["Update"] = {};
      if (typeof display_name === "string" && display_name.trim())
        nameFields.display_name = display_name.trim();
      if (typeof first_name === "string" && first_name.trim())
        nameFields.first_name = first_name.trim();
      if (typeof last_name === "string" && last_name.trim())
        nameFields.last_name = last_name.trim();

      if (hasCode && inviteId) {
        // 3a. Atomically claim the invite (prevents TOCTOU double-consume).
        // The WHERE used_by IS NULL ensures only one concurrent request wins.
        const { data: claimed } = await admin
          .from("invite_codes")
          .update({
            used_by: userData.user.id,
            used_at: new Date().toISOString(),
          })
          .eq("id", inviteId)
          .is("used_by", null)
          .select("id")
          .single();

        if (!claimed) {
          // Race lost — another request claimed this code. Clean up the user.
          await admin.auth.admin.deleteUser(userData.user.id);
          return NextResponse.json(
            { error: "Invalid or already used invite code" },
            { status: 400 }
          );
        }

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
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(err);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
