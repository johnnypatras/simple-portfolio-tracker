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
        // Global thresholds reflect that unit+component tests can't cover
        // server actions (need DB) or React pages (need full app context).
        // The valuable coverage is in src/lib/ — see per-file report.
        statements: 14,
        branches: 10,
        functions: 8,
        lines: 14,
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
