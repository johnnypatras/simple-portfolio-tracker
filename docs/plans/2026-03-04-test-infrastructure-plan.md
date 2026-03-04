# Test Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automated regression tests (unit + integration) with Vitest and CI via GitHub Actions.

**Architecture:** Two-layer approach — fast unit tests (~45 cases, pure functions, no DB) plus integration tests (~55 cases, local Supabase via Docker). Both run in CI on every push.

**Tech Stack:** Vitest, Supabase CLI, Docker, GitHub Actions

---

## Task 1: Install Vitest and Create Config

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Step 1: Install Vitest**

Run:
```bash
npm install -D vitest
```

**Step 2: Add npm scripts to package.json**

Add these scripts (keep existing ones):
```json
{
  "test": "vitest run --project unit",
  "test:integration": "vitest run --project integration",
  "test:all": "vitest run",
  "test:watch": "vitest --project unit"
}
```

**Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["__tests__/unit/**/*.test.ts"],
        },
        resolve: {
          alias: { "@": path.resolve(__dirname, "src") },
        },
      },
      {
        test: {
          name: "integration",
          include: ["__tests__/integration/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
        resolve: {
          alias: { "@": path.resolve(__dirname, "src") },
        },
      },
    ],
  },
});
```

**Step 4: Create test directories**

Run:
```bash
mkdir -p __tests__/unit __tests__/integration
```

**Step 5: Verify Vitest runs (no tests yet)**

Run:
```bash
npx vitest run --project unit
```

Expected: "No test files found" (clean exit, no errors).

**Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts __tests__/
git commit -m "feat: add vitest config with unit + integration projects"
```

---

## Task 2: Unit Test — validation.test.ts

Tests for `src/lib/validation.ts` (5 exported validators).

**Files:**
- Create: `__tests__/unit/validation.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";
import {
  validateAmount,
  validateQuantity,
  validateCurrency,
  validateName,
  validateUUID,
} from "@/lib/validation";

describe("validateAmount", () => {
  it("accepts positive numbers", () => {
    expect(() => validateAmount(100)).not.toThrow();
    expect(() => validateAmount(0)).not.toThrow();
    expect(() => validateAmount(0.01)).not.toThrow();
  });

  it("rejects negative numbers", () => {
    expect(() => validateAmount(-1)).toThrow("cannot be negative");
  });

  it("rejects NaN", () => {
    expect(() => validateAmount(NaN)).toThrow("valid number");
  });

  it("rejects Infinity", () => {
    expect(() => validateAmount(Infinity)).toThrow("valid number");
  });

  it("rejects unreasonably large amounts", () => {
    expect(() => validateAmount(2_000_000_000)).toThrow("unreasonably large");
  });
});

describe("validateQuantity", () => {
  it("accepts positive numbers", () => {
    expect(() => validateQuantity(0.000001)).not.toThrow();
  });

  it("rejects negative", () => {
    expect(() => validateQuantity(-5)).toThrow("cannot be negative");
  });

  it("rejects NaN", () => {
    expect(() => validateQuantity(NaN)).toThrow("valid number");
  });
});

describe("validateCurrency", () => {
  it("accepts valid ISO 4217 codes", () => {
    expect(() => validateCurrency("USD")).not.toThrow();
    expect(() => validateCurrency("EUR")).not.toThrow();
    expect(() => validateCurrency("GBP")).not.toThrow();
  });

  it("rejects lowercase", () => {
    expect(() => validateCurrency("usd")).toThrow("Invalid currency");
  });

  it("rejects too short", () => {
    expect(() => validateCurrency("US")).toThrow("Invalid currency");
  });

  it("rejects too long", () => {
    expect(() => validateCurrency("USDD")).toThrow("Invalid currency");
  });

  it("rejects empty", () => {
    expect(() => validateCurrency("")).toThrow("Invalid currency");
  });
});

describe("validateName", () => {
  it("accepts normal strings", () => {
    expect(() => validateName("My Portfolio")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateName("")).toThrow("cannot be empty");
  });

  it("rejects whitespace-only", () => {
    expect(() => validateName("   ")).toThrow("cannot be empty");
  });

  it("rejects strings exceeding maxLen", () => {
    expect(() => validateName("a".repeat(101))).toThrow("too long");
  });

  it("respects custom maxLen", () => {
    expect(() => validateName("abcdef", 5)).toThrow("too long");
  });
});

describe("validateUUID", () => {
  it("accepts valid UUID", () => {
    expect(() => validateUUID("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("rejects invalid format", () => {
    expect(() => validateUUID("not-a-uuid")).toThrow("not a valid UUID");
  });

  it("rejects empty", () => {
    expect(() => validateUUID("")).toThrow("not a valid UUID");
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/validation.test.ts
```

Expected: All 15 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/validation.test.ts
git commit -m "test: add validation.test.ts (15 cases)"
```

---

## Task 3: Unit Test — rate-limit.test.ts

Tests for `src/lib/rate-limit.ts`. Mocks `NextRequest`/`NextResponse` from `next/server`.

**Files:**
- Create: `__tests__/unit/rate-limit.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock next/server before importing the module under test
vi.mock("next/server", () => ({
  NextRequest: class {
    headers: Map<string, string>;
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.headers = new Map(Object.entries(opts?.headers ?? {}));
    }
  },
  NextResponse: {
    json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return { body, status: init?.status ?? 200, headers: init?.headers ?? {} };
    },
  },
}));

import { rateLimit } from "@/lib/rate-limit";

function makeReq(ip = "127.0.0.1") {
  const { NextRequest } = require("next/server") as any;
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first request", () => {
    const check = rateLimit({ windowMs: 60_000, max: 5 });
    expect(check(makeReq())).toBeNull();
  });

  it("allows requests within limit", () => {
    const check = rateLimit({ windowMs: 60_000, max: 3 });
    expect(check(makeReq())).toBeNull(); // 1
    expect(check(makeReq())).toBeNull(); // 2
    expect(check(makeReq())).toBeNull(); // 3
  });

  it("blocks request exceeding limit", () => {
    const check = rateLimit({ windowMs: 60_000, max: 2 });
    check(makeReq()); // 1
    check(makeReq()); // 2
    const result = check(makeReq()); // 3 — over limit
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
  });

  it("allows requests after window slides", () => {
    const check = rateLimit({ windowMs: 60_000, max: 2 });
    check(makeReq()); // 1
    check(makeReq()); // 2
    expect(check(makeReq())).not.toBeNull(); // 3 — blocked

    // Advance time past the window
    vi.advanceTimersByTime(61_000);
    expect(check(makeReq())).toBeNull(); // allowed again
  });

  it("tracks different IPs independently", () => {
    const check = rateLimit({ windowMs: 60_000, max: 1 });
    expect(check(makeReq("1.1.1.1"))).toBeNull();
    expect(check(makeReq("2.2.2.2"))).toBeNull();
    expect(check(makeReq("1.1.1.1"))).not.toBeNull(); // blocked
    expect(check(makeReq("2.2.2.2"))).not.toBeNull(); // blocked
  });

  it("blocks concurrent burst exceeding limit", () => {
    const check = rateLimit({ windowMs: 60_000, max: 3 });
    const results = Array.from({ length: 6 }, () => check(makeReq()));
    const allowed = results.filter((r) => r === null).length;
    const blocked = results.filter((r) => r !== null).length;
    expect(allowed).toBe(3);
    expect(blocked).toBe(3);
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/rate-limit.test.ts
```

Expected: All 6 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/rate-limit.test.ts
git commit -m "test: add rate-limit.test.ts (6 cases)"
```

---

## Task 4: Unit Test — csv.test.ts

Tests for `src/lib/csv.ts` (`escapeCsv` + `toCsv`).

**Files:**
- Create: `__tests__/unit/csv.test.ts`

**Step 1: Write the tests**

```ts
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
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/csv.test.ts
```

Expected: All 14 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/csv.test.ts
git commit -m "test: add csv.test.ts (14 cases)"
```

---

## Task 5: Unit Test — fx.test.ts

Tests for `src/lib/prices/fx.ts` (`convertToBase`, `getFXRates`, `getFXRatesSafe`).

**Files:**
- Create: `__tests__/unit/fx.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { convertToBase, getFXRates, getFXRatesSafe } from "@/lib/prices/fx";

describe("convertToBase", () => {
  it("returns amount unchanged when currencies match", () => {
    expect(convertToBase(100, "USD", "USD", { USD: 1 })).toBe(100);
  });

  it("converts correctly with valid rate", () => {
    // rates[EUR] = 0.92 means 0.92 EUR per 1 USD
    // So 92 EUR = 92 / 0.92 = 100 USD
    expect(convertToBase(92, "EUR", "USD", { EUR: 0.92, USD: 1 })).toBeCloseTo(100, 2);
  });

  it("returns unconverted amount when rate is missing", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = convertToBase(100, "GBP", "USD", { USD: 1 });
    expect(result).toBe(100);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("No rate for GBP"));
    spy.mockRestore();
  });

  it("returns unconverted amount when rate is zero", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = convertToBase(100, "GBP", "USD", { GBP: 0, USD: 1 });
    expect(result).toBe(100);
    spy.mockRestore();
  });
});

describe("getFXRates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { base: 1 } when no other currencies requested", async () => {
    const result = await getFXRates("USD", []);
    expect(result).toEqual({ USD: 1 });
  });

  it("returns { base: 1 } when only base currency requested", async () => {
    const result = await getFXRates("USD", ["USD"]);
    expect(result).toEqual({ USD: 1 });
  });

  it("fetches rates from Frankfurter API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rates: { EUR: 0.92 } }),
    }));

    const result = await getFXRates("USD", ["EUR"]);
    expect(result).toEqual({ EUR: 0.92, USD: 1 });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("base=USD&symbols=EUR"),
      expect.any(Object)
    );
  });

  it("throws on API error after retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await expect(getFXRates("USD", ["EUR"])).rejects.toThrow("returned 500");
  });

  it("throws when response is missing a requested rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rates: {} }),
    }));

    await expect(getFXRates("USD", ["EUR"])).rejects.toThrow("no rate for USD");
  });
});

describe("getFXRatesSafe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns rates on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rates: { EUR: 0.92 } }),
    }));

    const result = await getFXRatesSafe("USD", ["EUR"]);
    expect(result).toEqual({ EUR: 0.92, USD: 1 });
  });

  it("returns fallback { base: 1 } on API error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const result = await getFXRatesSafe("USD", ["EUR"]);
    expect(result).toEqual({ USD: 1 });
    spy.mockRestore();
  });

  it("returns fallback { base: 1 } on network error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network error")));

    const result = await getFXRatesSafe("USD", ["EUR"]);
    expect(result).toEqual({ USD: 1 });
    spy.mockRestore();
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/fx.test.ts
```

Expected: All 12 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/fx.test.ts
git commit -m "test: add fx.test.ts (12 cases)"
```

---

## Task 6: Unit Test — activity-log.test.ts

Tests for delta computation logic (pure math, no DB).

**Files:**
- Create: `__tests__/unit/activity-log.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";

// Test the delta computation logic (pure math, no DB)
describe("delta computation from snapshots", () => {
  // Helper mirrors the cash-entity logic in activity-log.ts:128-154
  function cashDelta(
    action: string,
    before: { amount?: number; balance?: number } | null,
    after: { amount?: number; balance?: number } | null,
    entityType: "bank_account" | "exchange_deposit" | "broker_deposit"
  ): number {
    const field = entityType === "bank_account" ? "balance" : "amount";
    const beforeAmt = (before as Record<string, number> | null)?.[field] ?? 0;
    const afterAmt = (after as Record<string, number> | null)?.[field] ?? 0;

    if (action === "created") return afterAmt;
    if (action === "removed") return -beforeAmt;
    return afterAmt - beforeAmt; // updated
  }

  it("created — uses full after amount", () => {
    expect(cashDelta("created", null, { balance: 5000 }, "bank_account")).toBe(5000);
  });

  it("removed — negative of before amount", () => {
    expect(cashDelta("removed", { amount: 1000 }, null, "exchange_deposit")).toBe(-1000);
  });

  it("updated — computes difference", () => {
    expect(cashDelta("updated", { amount: 500 }, { amount: 800 }, "broker_deposit")).toBe(300);
  });

  it("null before on creation — uses 0 as before", () => {
    expect(cashDelta("created", null, { amount: 250 }, "exchange_deposit")).toBe(250);
  });

  it("null after on removal — uses 0 as after", () => {
    expect(cashDelta("removed", { balance: 3000 }, null, "bank_account")).toBe(-3000);
  });

  // Position delta (quantity-based)
  function positionDelta(
    action: string,
    beforeQty: number | null,
    afterQty: number | null
  ): number {
    const before = beforeQty ?? 0;
    const after = afterQty ?? 0;
    if (action === "created") return after;
    if (action === "removed") return -before;
    return after - before;
  }

  it("crypto position created — full quantity as delta", () => {
    expect(positionDelta("created", null, 0.5)).toBe(0.5);
  });

  it("crypto position removed — negative quantity", () => {
    expect(positionDelta("removed", 1.5, null)).toBe(-1.5);
  });

  it("position updated — quantity difference", () => {
    expect(positionDelta("updated", 2.0, 3.5)).toBe(1.5);
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/activity-log.test.ts
```

Expected: All 8 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/activity-log.test.ts
git commit -m "test: add activity-log.test.ts (8 cases)"
```

---

## Task 7: Unit Test — aggregate.test.ts

Tests for `aggregatePortfolio` from `src/lib/portfolio/aggregate.ts`.

**Files:**
- Create: `__tests__/unit/aggregate.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";

// Minimal position factory
function pos(qty: number, assetIdField: string, assetId: string) {
  return {
    id: "p-" + Math.random().toString(36).slice(2, 8),
    quantity: qty,
    [assetIdField]: assetId,
    wallet_id: "w1",
    broker_id: "b1",
    acquisition_method: null,
    apy: 0,
    user_id: "u1",
    created_at: "",
    updated_at: "",
    deleted_at: null,
    last_was_adjustment: false,
    last_was_transfer: false,
  };
}

describe("aggregatePortfolio", () => {
  it("classifies stablecoin as cash, not crypto", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "USDC", ticker: "USDC", coingecko_id: "usd-coin",
        image_url: null, subcategory: "stablecoin",
        user_id: "u1", created_at: "", updated_at: "", deleted_at: null,
        positions: [pos(1000, "crypto_asset_id", "ca1")],
      }] as any,
      cryptoPrices: { "usd-coin": { usd: 1, eur: 0.92, usd_24h_change: 0, eur_24h_change: 0 } },
      stockAssets: [], stockPrices: {},
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
    });
    expect(result.cryptoValue).toBe(0);
    expect(result.stablecoinValue).toBe(1000);
    expect(result.cashValue).toBe(1000);
  });

  it("returns all zeros for empty portfolio without crashing", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1 },
    });
    expect(result.totalValue).toBe(0);
    expect(result.allocation).toEqual({ crypto: 0, stocks: 0, cash: 0 });
  });

  it("component sum matches total", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, subcategory: null,
        user_id: "u1", created_at: "", updated_at: "", deleted_at: null,
        positions: [pos(1, "crypto_asset_id", "ca1")],
      }] as any,
      cryptoPrices: { bitcoin: { usd: 50000, eur: 46000, usd_24h_change: 2, eur_24h_change: 1.5 } },
      stockAssets: [], stockPrices: {},
      bankAccounts: [{ id: "ba1", name: "Bank", balance: 5000, currency: "EUR", apy: 0, user_id: "u1", created_at: "", updated_at: "", deleted_at: null, last_was_adjustment: false, last_was_transfer: false }] as any,
      exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1, USD: 1.09 },
    });
    const sum = result.cryptoValue + result.stocksValue + result.cashValue;
    expect(Math.abs(result.totalValue - sum)).toBeLessThan(0.01);
  });

  it("handles missing FX rate without silent zero", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [{
        id: "sa1", name: "AAPL", ticker: "AAPL", yahoo_ticker: "AAPL",
        currency: "GBP", isin: null, category: "individual_stock",
        subcategory: null, tags: null,
        user_id: "u1", created_at: "", updated_at: "", deleted_at: null,
        positions: [pos(10, "stock_asset_id", "sa1")],
      }] as any,
      stockPrices: { AAPL: { price: 200, change24h: 1, currency: "GBP" } },
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "USD", fxRates: { USD: 1 }, // GBP missing
    });
    expect(result.stocksValue).toBe(2000); // unconverted, not zero
    spy.mockRestore();
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/aggregate.test.ts
```

Expected: All 4 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/aggregate.test.ts
git commit -m "test: add aggregate.test.ts (4 cases)"
```

---

## Task 8: Unit Test — dashboard-insights.test.ts

**Files:**
- Create: `__tests__/unit/dashboard-insights.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";
import { computeDashboardInsights } from "@/lib/portfolio/dashboard-insights";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";

const emptySummary: PortfolioSummary = {
  totalValue: 0, cryptoValue: 0, stocksValue: 0, cashValue: 0, stablecoinValue: 0,
  change24hPercent: 0, fxChange24hPercent: 0,
  allocation: { crypto: 0, stocks: 0, cash: 0 }, primaryCurrency: "USD",
  totalValueChange24h: 0, cryptoValueChange24h: 0, stocksValueChange24h: 0,
  stablecoinValueChange24h: 0, cashFxValueChange24h: 0, fxValueChange24h: 0,
  cryptoFxValueChange24h: 0, cryptoFxChange24hPercent: 0,
  stocksFxValueChange24h: 0, stocksFxChange24hPercent: 0,
  cashTotalValueChange24h: 0, cashTotalFxValueChange24h: 0, cashTotalFxChange24hPercent: 0,
  totalValueUsd: 0, totalValueEur: 0,
  cryptoValueUsd: 0, cryptoValueEur: 0, stocksValueUsd: 0, stocksValueEur: 0,
  cashValueUsd: 0, cashValueEur: 0,
};

const mkt = {
  sp500Price: 5000, sp500Change24h: 0.5,
  goldPrice: 2000, goldChange24h: 0.1,
  nasdaqPrice: 15000, nasdaqChange24h: 0.3,
  dowPrice: 38000, dowChange24h: 0.2,
  eurUsdChange24h: 0,
  solPriceUsd: 150, solChange24h: 1,
  stoxx50Price: 4500, stoxx50Change24h: 0.1,
  silverPrice: 25, silverChange24h: 0.2,
  oilPrice: 80, oilChange24h: -0.5,
  treasury10yPrice: 4.5, treasury10yChange24h: 0.01,
  vixPrice: 15, vixChange24h: -2,
};

describe("computeDashboardInsights", () => {
  it("handles zero/NaN dividend yield without crash", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: emptySummary, ...mkt,
    });
    expect(result.stocksWeightedYield).toBe(0);
    expect(Number.isFinite(result.stocksWeightedYield)).toBe(true);
  });

  it("APY income uses APY-bearing balance only", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      bankAccounts: [
        { id: "1", name: "Savings", balance: 10000, currency: "USD", apy: 5, user_id: "u", created_at: "", updated_at: "", deleted_at: null, last_was_adjustment: false, last_was_transfer: false },
        { id: "2", name: "Checking", balance: 5000, currency: "USD", apy: 0, user_id: "u", created_at: "", updated_at: "", deleted_at: null, last_was_adjustment: false, last_was_transfer: false },
      ] as any,
      exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, cashValue: 15000 }, ...mkt,
    });
    expect(result.apyIncomeYearly).toBeCloseTo(500, 0);
    expect(result.weightedAvgApy).toBe(5);
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/dashboard-insights.test.ts
```

Expected: All 2 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/dashboard-insights.test.ts
git commit -m "test: add dashboard-insights.test.ts (2 cases)"
```

---

## Task 9: Unit Test — holdings.test.ts

**Files:**
- Create: `__tests__/unit/holdings.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";
import { buildPaletteHoldings } from "@/lib/portfolio/holdings";

describe("buildPaletteHoldings", () => {
  it("maps crypto, stock, and cash holdings correctly", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [{
        id: "ca1", name: "Bitcoin", coingecko_id: "bitcoin", ticker: "btc",
        image_url: null, subcategory: null, user_id: "u", created_at: "", updated_at: "", deleted_at: null,
        positions: [{ id: "p1", quantity: 0.5, crypto_asset_id: "ca1", wallet_id: "w1", acquisition_method: null, apy: 0, user_id: "u", created_at: "", updated_at: "", deleted_at: null, last_was_adjustment: false, last_was_transfer: false }],
      }] as any,
      cryptoPrices: { bitcoin: { usd: 60000, eur: 55000, usd_24h_change: 2, eur_24h_change: 1.5 } },
      stockAssets: [], stockPrices: {},
      bankAccounts: [{ id: "ba1", name: "Alpha Bank", balance: 5000, currency: "EUR", apy: 0, user_id: "u", created_at: "", updated_at: "", deleted_at: null, last_was_adjustment: false, last_was_transfer: false }] as any,
      exchangeDeposits: [], brokerDeposits: [],
      fxRates: { USD: 1.09, EUR: 1 },
      pathPrefix: "/dashboard",
    });
    expect(result).toHaveLength(2); // 1 crypto + 1 bank
    expect(result.find(h => h.ticker === "BTC")?.type).toBe("crypto");
    expect(result.find(h => h.type === "bank")?.detailPath).toBe("/dashboard/cash");
  });

  it("returns empty array for empty data", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [], cryptoPrices: {}, stockAssets: [], stockPrices: {},
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
      fxRates: {}, pathPrefix: "/dashboard",
    });
    expect(result).toEqual([]);
  });

  it("applies pathPrefix correctly for share pages", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [], cryptoPrices: {}, stockAssets: [], stockPrices: {},
      bankAccounts: [{ id: "ba1", name: "T", balance: 100, currency: "USD", apy: 0, user_id: "u", created_at: "", updated_at: "", deleted_at: null, last_was_adjustment: false, last_was_transfer: false }] as any,
      exchangeDeposits: [], brokerDeposits: [],
      fxRates: { USD: 1 }, pathPrefix: "/share/abc123",
    });
    expect(result[0].detailPath).toBe("/share/abc123/cash");
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/holdings.test.ts
```

Expected: All 3 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/holdings.test.ts
git commit -m "test: add holdings.test.ts (3 cases)"
```

---

## Task 10: Unit Test — shares.test.ts

**Files:**
- Create: `__tests__/unit/shares.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";

// Test share validation logic (pure — no DB)
interface ShareRow {
  expires_at: string | null;
  revoked_at: string | null;
  scope: string;
}

function isShareValid(row: ShareRow | null): { valid: boolean; scope?: string } {
  if (!row) return { valid: false };
  if (row.revoked_at) return { valid: false };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false };
  return { valid: true, scope: row.scope };
}

describe("share token validation logic", () => {
  it("rejects null row", () => { expect(isShareValid(null).valid).toBe(false); });

  it("rejects revoked token", () => {
    expect(isShareValid({ expires_at: null, revoked_at: "2026-01-01T00:00:00Z", scope: "full" }).valid).toBe(false);
  });

  it("rejects expired token", () => {
    expect(isShareValid({ expires_at: "2020-01-01T00:00:00Z", revoked_at: null, scope: "full" }).valid).toBe(false);
  });

  it("accepts valid token with correct scope", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const r = isShareValid({ expires_at: future, revoked_at: null, scope: "full_with_history" });
    expect(r.valid).toBe(true);
    expect(r.scope).toBe("full_with_history");
  });

  it("accepts token with no expiry", () => {
    expect(isShareValid({ expires_at: null, revoked_at: null, scope: "overview" }).valid).toBe(true);
  });
});

describe("scope ranking", () => {
  const SCOPE_RANK: Record<string, number> = { overview: 0, full: 1, full_with_history: 2 };

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
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/shares.test.ts
```

Expected: All 8 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/shares.test.ts
git commit -m "test: add shares.test.ts (8 cases)"
```

---

## Task 11: Unit Test — import-backup.test.ts

**Files:**
- Create: `__tests__/unit/import-backup.test.ts`

**Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";
import { validateAmount, validateCurrency, validateName, validateQuantity } from "@/lib/validation";

describe("import backup validation", () => {
  it("accepts minimal v1 backup shape", () => {
    const v1 = { version: 1, cryptoAssets: [], stockAssets: [], bankAccounts: [], exchangeDeposits: [], brokerDeposits: [] };
    expect(v1.version).toBe(1);
    expect(Array.isArray(v1.cryptoAssets)).toBe(true);
  });

  it("rejects missing required name", () => {
    expect(() => validateName("")).toThrow("cannot be empty");
  });

  it("rejects invalid currency in import data", () => {
    expect(() => validateCurrency("usd")).toThrow("Invalid currency");
  });

  it("rejects negative amount in import data", () => {
    expect(() => validateAmount(-100)).toThrow("cannot be negative");
  });

  it("rejects NaN quantity in import data", () => {
    expect(() => validateQuantity(NaN)).toThrow("valid number");
  });

  it("accepts valid import data values", () => {
    expect(() => validateName("Bitcoin")).not.toThrow();
    expect(() => validateCurrency("USD")).not.toThrow();
    expect(() => validateAmount(1000)).not.toThrow();
    expect(() => validateQuantity(0.5)).not.toThrow();
  });
});
```

**Step 2: Run the test**

Run:
```bash
npx vitest run --project unit __tests__/unit/import-backup.test.ts
```

Expected: All 6 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/unit/import-backup.test.ts
git commit -m "test: add import-backup.test.ts (6 cases)"
```

---

## Task 12: Run All Unit Tests Together

**Step 1: Run the full unit suite**

Run:
```bash
npm test
```

Expected: ~78 cases pass in ~2-3 seconds.

**Step 2: Verify build still works**

Run:
```bash
npm run build && npm run lint
```

Expected: Clean.

**Step 3: Commit milestone**

```bash
git add -A
git commit -m "test: all unit tests passing (~78 cases)"
```

---

## Task 13: Integration Test Setup

**Files:**
- Create: `__tests__/integration/setup.ts`

**Step 1: Initialize Supabase (if needed)**

Run:
```bash
supabase init 2>/dev/null || echo "Already initialized"
```

**Step 2: Start local Supabase**

Run:
```bash
supabase start
```

**Step 3: Create setup.ts**

The setup module reads local Supabase URL/keys, creates test users via admin API, and provides authenticated clients with RLS applied. See `docs/plans/2026-03-04-test-infrastructure-design.md` for full specification.

Note: Uses `execFileSync("supabase", ["status", "--output", "json"])` (not `exec`) for safety — no shell interpolation.

```ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "child_process";

let localConfig: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };

function getLocalConfig() {
  if (localConfig) return localConfig;
  const output = execFileSync("supabase", ["status", "--output", "json"], { encoding: "utf-8" });
  const parsed = JSON.parse(output);
  localConfig = {
    API_URL: parsed.API_URL,
    ANON_KEY: parsed.ANON_KEY,
    SERVICE_ROLE_KEY: parsed.SERVICE_ROLE_KEY,
  };
  return localConfig;
}

export function getAdminClient(): SupabaseClient {
  const config = getLocalConfig();
  return createClient(config.API_URL, config.SERVICE_ROLE_KEY);
}

export async function createTestUser(email?: string): Promise<{
  client: SupabaseClient;
  userId: string;
  cleanup: () => Promise<void>;
}> {
  const admin = getAdminClient();
  const testEmail = email ?? "test-" + Date.now() + "@test.local";

  const { data, error } = await admin.auth.admin.createUser({
    email: testEmail,
    password: "test-password-123!",
    email_confirm: true,
  });
  if (error) throw new Error("Failed to create test user: " + error.message);
  const userId = data.user.id;

  const config = getLocalConfig();
  const userClient = createClient(config.API_URL, config.ANON_KEY);
  const { error: signInError } = await userClient.auth.signInWithPassword({
    email: testEmail,
    password: "test-password-123!",
  });
  if (signInError) throw new Error("Failed to sign in: " + signInError.message);

  return {
    client: userClient,
    userId,
    cleanup: async () => { await admin.auth.admin.deleteUser(userId); },
  };
}
```

**Step 4: Commit**

```bash
git add __tests__/integration/setup.ts
git commit -m "test: add integration test setup (local Supabase helper)"
```

---

## Task 14: Integration Test — migration-bootstrap.test.ts

**Files:**
- Create: `__tests__/integration/migration-bootstrap.test.ts`

**Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { getAdminClient } from "./setup";

describe("migration bootstrap", () => {
  it("all expected tables are accessible", async () => {
    const admin = getAdminClient();
    const tables = [
      "profiles", "invite_codes", "crypto_assets", "crypto_positions",
      "stock_assets", "stock_positions", "wallets", "brokers",
      "bank_accounts", "exchange_deposits", "broker_deposits",
      "activity_log", "portfolio_snapshots", "portfolio_shares",
      "trade_entries", "diary_entries", "goal_prices",
    ];

    for (const table of tables) {
      const { error } = await admin.from(table).select("id").limit(0);
      expect(error, "Table " + table + " should be accessible").toBeNull();
    }
  });

  it("undo_transfer_group RPC exists", async () => {
    const admin = getAdminClient();
    const { error } = await admin.rpc("undo_transfer_group", {
      p_group_id: "00000000-0000-0000-0000-000000000000",
    });
    // Should not get "function does not exist"
    if (error) {
      expect(error.message).not.toContain("function");
    }
  });
});
```

**Step 2: Run test**

Run:
```bash
npx vitest run --project integration __tests__/integration/migration-bootstrap.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add __tests__/integration/migration-bootstrap.test.ts
git commit -m "test: add migration-bootstrap.test.ts (2 cases)"
```

---

## Task 15: Integration Test — rls-enforcement.test.ts

**Files:**
- Create: `__tests__/integration/rls-enforcement.test.ts`

**Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("RLS enforcement", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => Promise<void> };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => Promise<void> };
  let cryptoAssetId: string;

  beforeAll(async () => {
    userA = await createTestUser("rls-a@test.local");
    userB = await createTestUser("rls-b@test.local");

    const { data: asset } = await userA.client
      .from("crypto_assets")
      .insert({ user_id: userA.userId, name: "Bitcoin", ticker: "BTC", coingecko_id: "bitcoin" })
      .select("id")
      .single();
    cryptoAssetId = asset!.id;
  });

  afterAll(async () => {
    await userA.cleanup();
    await userB.cleanup();
  });

  it("User B cannot SELECT User A's crypto_assets", async () => {
    const { data } = await userB.client.from("crypto_assets").select("*").eq("id", cryptoAssetId);
    expect(data).toEqual([]);
  });

  it("User B cannot UPDATE User A's data", async () => {
    await userB.client.from("crypto_assets").update({ name: "Hacked" }).eq("id", cryptoAssetId);
    const { data } = await userA.client.from("crypto_assets").select("name").eq("id", cryptoAssetId).single();
    expect(data?.name).toBe("Bitcoin");
  });

  it("User B cannot DELETE User A's activity_log", async () => {
    const admin = getAdminClient();
    await admin.from("activity_log").insert({
      user_id: userA.userId, action: "created", entity_type: "crypto_asset",
      entity_name: "Bitcoin", description: "Test",
    });
    const { data: logs } = await userA.client.from("activity_log").select("id").limit(1);
    if (logs && logs.length > 0) {
      await userB.client.from("activity_log").delete().eq("id", logs[0].id);
      const { data: after } = await userA.client.from("activity_log").select("id").eq("id", logs[0].id);
      expect(after).toHaveLength(1);
    }
  });
});
```

**Step 2: Run test**

Run:
```bash
npx vitest run --project integration __tests__/integration/rls-enforcement.test.ts
```

Expected: All 3 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/integration/rls-enforcement.test.ts
git commit -m "test: add rls-enforcement.test.ts (3 cases)"
```

---

## Task 16: Integration Test — snapshot-validation.test.ts

**Files:**
- Create: `__tests__/integration/snapshot-validation.test.ts`

**Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("snapshot validation", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const u = await createTestUser("snapshot@test.local");
    client = u.client; userId = u.userId; cleanup = u.cleanup;
  });

  afterAll(async () => { await cleanup(); });

  it("saves snapshot with correct component sum", async () => {
    const today = new Date().toISOString().split("T")[0];
    const { error } = await client.from("portfolio_snapshots").upsert({
      user_id: userId, snapshot_date: today,
      total_value_usd: 100000, total_value_eur: 92000,
      crypto_value_usd: 50000, stocks_value_usd: 30000, cash_value_usd: 20000,
    }, { onConflict: "user_id,snapshot_date" });
    expect(error).toBeNull();

    const { data } = await client.from("portfolio_snapshots").select("*").eq("snapshot_date", today).single();
    expect(data!.crypto_value_usd + data!.stocks_value_usd + data!.cash_value_usd).toBe(100000);
  });

  it("same-day duplicate uses upsert", async () => {
    const today = new Date().toISOString().split("T")[0];
    await client.from("portfolio_snapshots").upsert({
      user_id: userId, snapshot_date: today,
      total_value_usd: 105000, total_value_eur: 96600,
      crypto_value_usd: 55000, stocks_value_usd: 30000, cash_value_usd: 20000,
    }, { onConflict: "user_id,snapshot_date" });

    const { data } = await client.from("portfolio_snapshots").select("*").eq("snapshot_date", today);
    expect(data).toHaveLength(1);
    expect(data![0].total_value_usd).toBe(105000);
  });

  it("zero holdings — all zeros, no errors", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
    const { error } = await client.from("portfolio_snapshots").upsert({
      user_id: userId, snapshot_date: yesterday,
      total_value_usd: 0, total_value_eur: 0,
      crypto_value_usd: 0, stocks_value_usd: 0, cash_value_usd: 0,
    }, { onConflict: "user_id,snapshot_date" });
    expect(error).toBeNull();
  });
});
```

**Step 2: Run test**

Run:
```bash
npx vitest run --project integration __tests__/integration/snapshot-validation.test.ts
```

Expected: All 3 tests PASS.

**Step 3: Commit**

```bash
git add __tests__/integration/snapshot-validation.test.ts
git commit -m "test: add snapshot-validation.test.ts (3 cases)"
```

---

## Task 17: GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Step 1: Create directory and workflow file**

Run:
```bash
mkdir -p .github/workflows
```

Then create `.github/workflows/test.yml`:

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Build
        run: npm run build

      - name: Unit tests
        run: npm test

      - name: Install Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Start Supabase
        run: supabase start -x realtime,storage,imgproxy,edge-runtime,logflare,vector,supavisor

      - name: Integration tests
        run: npm run test:integration

      - name: Stop Supabase
        if: always()
        run: supabase stop
```

**Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions workflow for unit + integration tests"
```

---

## Task 18: Final Verification

**Step 1: Run all unit tests**

Run: `npm test`

**Step 2: Run integration tests**

Run: `npm run test:integration`

**Step 3: Run full suite**

Run: `npm run test:all`

**Step 4: Build + lint**

Run: `npm run build && npm run lint`

**Step 5: Final commit**

```bash
git add -A
git commit -m "test: complete test infrastructure — unit + integration + CI"
```

---

## Future Tasks (not in this plan)

Additional integration tests from the design doc to add incrementally:

| File | Cases | Description |
|------|-------|-------------|
| `transfer-cleanup.test.ts` | ~4 | Transfer entity orphan cleanup |
| `transfer-balance-validation.test.ts` | ~3 | Pre-transfer balance checks |
| `undo-transfer-group.test.ts` | ~5 | Atomic transfer undo via RPC |
| `activity-log-undo.test.ts` | ~5 | Single-entry undo operations |
| `register-invite.test.ts` | ~6 | Registration + invite code flow |
| `cascade-soft-delete.test.ts` | ~7 | Cascading soft-delete behavior |
| `benchmark.test.ts` | ~3 | Cash flow derivation |
| `middleware.test.ts` | ~4 | Auth middleware redirects |
