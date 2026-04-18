import { describe, it, expect } from "vitest";
import { pickJoinedName } from "@/lib/supabase/join-utils";

describe("pickJoinedName", () => {
  it("returns name from an object-shape join", () => {
    expect(pickJoinedName({ name: "Alpha Bank" })).toBe("Alpha Bank");
  });

  it("returns name from the first element of an array-shape join", () => {
    expect(pickJoinedName([{ name: "Ledger" }])).toBe("Ledger");
  });

  it("returns null for null input", () => {
    expect(pickJoinedName(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(pickJoinedName(undefined)).toBe(null);
  });

  it("returns null for an empty array", () => {
    expect(pickJoinedName([])).toBe(null);
  });

  it("returns null when name is missing from the object", () => {
    expect(pickJoinedName({})).toBe(null);
  });

  it("returns null when name is missing from array element", () => {
    expect(pickJoinedName([{}])).toBe(null);
  });

  it("ignores subsequent array elements (only first matters)", () => {
    expect(pickJoinedName([{ name: "First" }, { name: "Second" }])).toBe("First");
  });

  it("returns null for non-object / non-array primitives", () => {
    expect(pickJoinedName("string")).toBe(null);
    expect(pickJoinedName(42)).toBe(null);
  });

  it("returns null for boolean primitives", () => {
    expect(pickJoinedName(true)).toBe(null);
    expect(pickJoinedName(false)).toBe(null);
  });

  it("returns null for Date objects (typeof object, but no `name` property)", () => {
    // Dates are objects — the `v as { name?: string }` path yields `undefined`
    expect(pickJoinedName(new Date())).toBe(null);
  });

  it("returns null for nested arrays (`.name` absent on inner array)", () => {
    expect(pickJoinedName([[{ name: "nested" }]])).toBe(null);
  });
});
