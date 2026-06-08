import { describe, it, expect } from "vitest";
import { omitWriteTimePrice } from "@/lib/backdated-price";

describe("omitWriteTimePrice", () => {
  it("backdated + no user cost → omit price (defer to backfill at effective_date)", () => {
    expect(omitWriteTimePrice("2024-01-15", false)).toBe(true);
  });
  it("backdated + has user cost → keep (the user cost is verbatim; price irrelevant)", () => {
    expect(omitWriteTimePrice("2024-01-15", true)).toBe(false);
  });
  it("today (no effective_date) + no cost → keep today's price (it IS the effective-date price)", () => {
    expect(omitWriteTimePrice(undefined, false)).toBe(false);
    expect(omitWriteTimePrice("", false)).toBe(false);
  });
  it("today + has cost → keep", () => {
    expect(omitWriteTimePrice(undefined, true)).toBe(false);
  });
});
