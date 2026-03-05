import { describe, it, expect } from "vitest";
import { isShareValid, SCOPE_RANK } from "@/lib/share-utils";

describe("share token validation logic", () => {
  it("rejects null row", () => {
    expect(isShareValid(null).valid).toBe(false);
  });

  it("rejects revoked token", () => {
    expect(
      isShareValid({
        expires_at: null,
        revoked_at: "2026-01-01T00:00:00Z",
        scope: "full",
      }).valid
    ).toBe(false);
  });

  it("rejects expired token", () => {
    expect(
      isShareValid({
        expires_at: "2020-01-01T00:00:00Z",
        revoked_at: null,
        scope: "full",
      }).valid
    ).toBe(false);
  });

  it("accepts valid token with correct scope", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const r = isShareValid({
      expires_at: future,
      revoked_at: null,
      scope: "full_with_history",
    });
    expect(r.valid).toBe(true);
    expect(r.scope).toBe("full_with_history");
  });

  it("accepts token with no expiry", () => {
    expect(
      isShareValid({
        expires_at: null,
        revoked_at: null,
        scope: "overview",
      }).valid
    ).toBe(true);
  });
});

describe("scope ranking", () => {
  it("overview < full < full_with_history", () => {
    expect(SCOPE_RANK["overview"]).toBeLessThan(SCOPE_RANK["full"]);
    expect(SCOPE_RANK["full"]).toBeLessThan(SCOPE_RANK["full_with_history"]);
  });

  it("full_with_history grants access to full-required pages", () => {
    expect(SCOPE_RANK["full_with_history"] >= SCOPE_RANK["full"]).toBe(true);
  });

  it("overview does NOT grant access to full-required pages", () => {
    expect(SCOPE_RANK["overview"] >= SCOPE_RANK["full"]).toBe(false);
  });
});
