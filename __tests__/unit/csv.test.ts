import { describe, it, expect } from "vitest";
import { escapeCsv, toCsv } from "@/lib/csv";

describe("escapeCsv", () => {
  it("returns normal strings unchanged", () => {
    expect(escapeCsv("hello")).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(escapeCsv(null)).toBe("");
    expect(escapeCsv(undefined)).toBe("");
  });

  it("wraps strings with commas in quotes", () => {
    expect(escapeCsv("a,b")).toBe('"a,b"');
  });

  it("escapes double quotes inside strings", () => {
    expect(escapeCsv('say "hello"')).toBe('"say ""hello"""');
  });

  it("neutralizes formula injection with = prefix", () => {
    expect(escapeCsv("=SUM(A1)")).toBe("'=SUM(A1)");
  });

  it("neutralizes formula injection with + prefix", () => {
    expect(escapeCsv("+cmd")).toBe("'+cmd");
  });

  it("neutralizes formula injection with - prefix", () => {
    expect(escapeCsv("-1+1")).toBe("'-1+1");
  });

  it("neutralizes formula injection with @ prefix", () => {
    expect(escapeCsv("@SUM")).toBe("'@SUM");
  });

  it("neutralizes formula injection with tab prefix", () => {
    expect(escapeCsv("\tcmd")).toBe("'\tcmd");
  });

  it("neutralizes formula injection with \\r prefix", () => {
    expect(escapeCsv("\rcmd")).toBe("'\rcmd");
  });

  it("converts numbers to strings", () => {
    expect(escapeCsv(42)).toBe("42");
  });
});

describe("toCsv", () => {
  it("produces valid CSV output", () => {
    const result = toCsv(["Name", "Value"], [
      ["BTC", 50000],
      ["ETH", 3000],
    ]);
    expect(result).toBe("Name,Value\nBTC,50000\nETH,3000");
  });

  it("handles empty rows", () => {
    const result = toCsv(["A"], []);
    expect(result).toBe("A");
  });

  it("escapes special characters in output", () => {
    const result = toCsv(["Name"], [["=evil"]]);
    expect(result).toBe("Name\n'=evil");
  });
});
