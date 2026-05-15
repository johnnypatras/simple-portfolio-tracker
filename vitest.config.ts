import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "text-summary", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.{ts,tsx}",
        "src/instrumentation.ts",
        "src/instrumentation-client.ts",
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        "src/app/**/not-found.tsx",
      ],
      thresholds: {
        // Global baseline — safety net for regressions across all code.
        // Low because server actions (need DB) and React pages (need browser)
        // can't be covered by unit+component tests.
        statements: 18,
        branches: 14,
        functions: 12,
        lines: 19,

        // ── Pure utility modules (currently 85-100%) ──
        "src/lib/activity-fx.ts": { statements: 95, branches: 85, functions: 95, lines: 95 },
        "src/lib/cashflow.ts": { statements: 90, branches: 80, functions: 95, lines: 90 },
        "src/lib/csv.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },
        "src/lib/deltas.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },
        "src/lib/format.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/lib/rate-limit.ts": { statements: 80, branches: 85, functions: 75, lines: 86 },
        "src/lib/manual-nav.ts": { statements: 85, branches: 70, functions: 70, lines: 88 },
        "src/lib/share-utils.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },
        "src/lib/split-helpers.ts": { statements: 95, branches: 85, functions: 95, lines: 95 },
        "src/lib/stock-categories.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },
        "src/lib/validation.ts": { statements: 94, branches: 92, functions: 87, lines: 96 },
        "src/lib/undo-remap.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },

        // ── Manual-NAV action module — server action mutations ──
        // src/lib/actions/manual-nav.ts is covered by manual-nav-actions.test.ts
        // (23 unit tests with vi.hoisted + vi.mock pattern). High threshold
        // reflects the audit-driven coverage push and the security-critical
        // nature of the mutations (RLS-scoped, validators, kind verification).
        "src/lib/actions/manual-nav.ts": { statements: 95, branches: 85, functions: 95, lines: 95 },

        // ── Portfolio analysis modules (currently 89-100%) ──
        "src/lib/portfolio/aggregate.ts": { statements: 90, branches: 65, functions: 95, lines: 95 },
        "src/lib/portfolio/chart-enrichment.ts": { statements: 85, branches: 75, functions: 95, lines: 90 },
        "src/lib/portfolio/dashboard-changes.ts": { statements: 90, branches: 80, functions: 95, lines: 95 },
        "src/lib/portfolio/dashboard-insights.ts": { statements: 90, branches: 75, functions: 80, lines: 95 },
        "src/lib/portfolio/holdings.ts": { statements: 95, branches: 70, functions: 95, lines: 95 },
        "src/lib/portfolio/institution-grouping.ts": { statements: 85, branches: 55, functions: 95, lines: 90 },
        // Pure-augmentation functions are at ~95%; `fetchManualNavInputsFor`
        // pulls the file-level number down because it's a DB-touching helper
        // covered by manual-nav-cross-user.test.ts (integration), not unit.
        // Functions threshold ratcheted to 75% (actual: 4/5 = 80%) to catch
        // a regression that drops one of the 4 unit-covered functions.
        "src/lib/portfolio/manual-nav-augmentation.ts": { statements: 80, branches: 65, functions: 75, lines: 82 },

        // ── Price utilities (currently 77-100%) ──
        "src/lib/prices/coingecko.ts": { statements: 75, branches: 60, functions: 75, lines: 75 },
        "src/lib/prices/yahoo.ts": { statements: 85, branches: 75, functions: 90, lines: 85 },
        "src/lib/prices/fx.ts": { statements: 90, branches: 85, functions: 95, lines: 90 },
        "src/lib/prices/fetch-with-timeout.ts": { statements: 95, branches: 95, functions: 95, lines: 95 },
      },
    },
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
          name: "component",
          include: ["__tests__/component/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["__tests__/component/setup.ts"],
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
