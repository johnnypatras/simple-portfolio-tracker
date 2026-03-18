import { describe, it, expect } from "vitest";
import { partialUpdate } from "@/lib/partial-update";

describe("partialUpdate", () => {
  it("strips undefined keys", () => {
    expect(partialUpdate({ name: "Test", region: undefined })).toEqual({ name: "Test" });
  });

  it("preserves null values (explicit set-to-null)", () => {
    expect(partialUpdate({ name: "Test", region: null })).toEqual({ name: "Test", region: null });
  });

  it("preserves falsy values (0, empty string, false)", () => {
    expect(partialUpdate({ balance: 0, name: "", active: false })).toEqual({
      balance: 0,
      name: "",
      active: false,
    });
  });

  it("returns empty object when all values are undefined", () => {
    expect(partialUpdate({ a: undefined, b: undefined })).toEqual({});
  });

  it("returns full object when no values are undefined", () => {
    const input = { name: "Test", balance: 100, apy: 0.5 };
    expect(partialUpdate(input)).toEqual(input);
  });
});
