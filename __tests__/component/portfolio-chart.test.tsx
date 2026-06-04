/**
 * Component tests for PortfolioChart cost-basis overlay (Tasks 5.1 + 5.2).
 *
 * Recharts components use ResizeObserver which is absent in jsdom. We mock the
 * entire recharts module with minimal pass-through components so the render path
 * runs without crashing, and then assert on the DOM output that lives OUTSIDE
 * the Recharts layer (legend text, info icons, toggle buttons).
 *
 * The data-merge logic (mergeCostBasisIntoChart) is already covered by unit tests
 * in chart-enrichment.test.ts; here we only verify that the chart component
 * renders/hides the cost-basis legend entry and button in the right conditions.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PortfolioSnapshot, CashFlowEvent } from "@/lib/types";
import type { CostBasisSeriesPoint } from "@/lib/portfolio/chart-enrichment";

// ── Mock Recharts ──────────────────────────────────────────
// Recharts relies on ResizeObserver + SVG layout which jsdom doesn't support.
// Replace all Recharts components with <div data-testid="..."> stubs that render
// their children so the component tree can mount without errors.
vi.mock("recharts", () => {
  const { createElement, type: _t } = { createElement: (tag: string, props: object, ...children: unknown[]) => ({ tag, props, children }), type: null };
  void createElement; void _t;
  // Each stub is a named function component so React does not complain about
  // missing display names (lint rule react/display-name).
  function ComposedChart({ children }: { children?: React.ReactNode }) {
    return <div data-testid="ComposedChart">{children}</div>;
  }
  function Area() { return null; }
  function Line() { return null; }
  function XAxis() { return null; }
  function YAxis() { return null; }
  function Tooltip() { return null; }
  function ResponsiveContainer({ children }: { children?: React.ReactNode }) {
    return <div data-testid="ResponsiveContainer">{children}</div>;
  }
  function ReferenceLine() { return null; }
  return { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine };
});

// ── Mock Sentry (dynamic import inside enrichChartData) ────
vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: vi.fn(),
}));

// ── Test data ──────────────────────────────────────────────

function makeSnapshot(date: string, value: number): PortfolioSnapshot {
  return {
    id: date,
    user_id: "u1",
    snapshot_date: date,
    total_value_eur: value,
    total_value_usd: value,
    crypto_value_usd: value * 0.5,
    stocks_value_usd: value * 0.3,
    cash_value_usd: value * 0.2,
    crypto_value_eur: null,
    stocks_value_eur: null,
    cash_value_eur: null,
    stocks_eur_denominated_value: null,
    cash_eur_denominated_value: null,
    created_at: date + "T00:00:00Z",
  };
}

// Use dates within the last 30 days so the 30D default period filter keeps them.
const TODAY = new Date().toISOString().split("T")[0];
const d1 = new Date(Date.now() - 3 * 86_400_000).toISOString().split("T")[0];
const d2 = new Date(Date.now() - 2 * 86_400_000).toISOString().split("T")[0];
const d3 = new Date(Date.now() - 1 * 86_400_000).toISOString().split("T")[0];

const SNAPSHOTS: PortfolioSnapshot[] = [
  makeSnapshot(d1, 10000),
  makeSnapshot(d2, 10500),
  makeSnapshot(d3, 11000),
];

const SP500_HISTORY = [
  { date: d1, close: 5000 },
  { date: d2, close: 5050 },
  { date: d3, close: 5100 },
  { date: TODAY, close: 5080 },
];

const CASH_FLOWS: CashFlowEvent[] = [
  { date: d1, amount_usd: 10000 },
];

function makeCostSeries(): CostBasisSeriesPoint[] {
  return [
    {
      date: d1,
      cryptoCostUsd: 5000, cryptoCostEur: 4500,
      stocksCostUsd: 3000, stocksCostEur: 2700,
      cashCostUsd: 1000,  cashCostEur: 900,
      cryptoGapUsd: 500,  stocksGapUsd: 0, cashGapUsd: 0,
    },
  ];
}

// ── Import AFTER mocks so the component gets mocked recharts ──
const { PortfolioChart } = await import("@/components/dashboard/portfolio-chart");

// ── Tests ──────────────────────────────────────────────────

describe("PortfolioChart — cost-basis overlay", () => {
  /**
   * (1) With a series → cost line legend renders unconditionally (always-on).
   * The legend text "Cost basis" should be present when `costBasisSeries` is
   * populated and returnMode is OFF. There is no toggle button.
   */
  it("(1) with costBasisSeries: legend 'Cost basis' is always rendered", () => {
    render(
      <PortfolioChart
        snapshots={SNAPSHOTS}
        liveValue={11000}
        liveValueUsd={11000}
        primaryCurrency="USD"
        sp500History={SP500_HISTORY}
        cashFlows={CASH_FLOWS}
        costBasisSeries={makeCostSeries()}
      />,
    );

    // Legend entry text is present without any user interaction
    expect(screen.getByText("Cost basis")).toBeTruthy();
    // No "Cost" toggle button — always-on per project precedent
    expect(screen.queryByTitle(/toggle cost basis/i)).toBeNull();
  });

  /**
   * (2) % return mode → cost line legend absent (return mode hides cost overlay).
   * When `defaultReturnMode` is true, the cost overlay should be hidden.
   */
  it("(2) % return mode: 'Cost basis' legend is absent", () => {
    render(
      <PortfolioChart
        snapshots={SNAPSHOTS}
        liveValue={11000}
        liveValueUsd={11000}
        primaryCurrency="USD"
        sp500History={SP500_HISTORY}
        cashFlows={CASH_FLOWS}
        costBasisSeries={makeCostSeries()}
        defaultReturnMode
      />,
    );

    // Legend entry text "Cost basis" should NOT appear in return mode
    expect(screen.queryByText("Cost basis")).toBeNull();
  });

  /**
   * (3) No series → cost overlay absent entirely (no legend, no toggle button).
   */
  it("(3) no costBasisSeries: 'Cost basis' legend and 'Cost' button absent", () => {
    render(
      <PortfolioChart
        snapshots={SNAPSHOTS}
        liveValue={11000}
        liveValueUsd={11000}
        primaryCurrency="USD"
        sp500History={SP500_HISTORY}
        cashFlows={CASH_FLOWS}
      />,
    );

    expect(screen.queryByText("Cost basis")).toBeNull();
    // No "Cost" toggle button when series absent
    expect(screen.queryByRole("button", { name: /cost basis/i })).toBeNull();
  });

  /**
   * (4) Always-on: cost basis legend remains visible without user interaction.
   * Previously tested toggle-off behaviour; now confirms always-rendered contract.
   */
  it("(4) cost basis legend is rendered without any interaction (always-on)", () => {
    render(
      <PortfolioChart
        snapshots={SNAPSHOTS}
        liveValue={11000}
        liveValueUsd={11000}
        primaryCurrency="USD"
        sp500History={SP500_HISTORY}
        cashFlows={CASH_FLOWS}
        costBasisSeries={makeCostSeries()}
      />,
    );

    // Rendered on first mount, no click needed
    expect(screen.getByText("Cost basis")).toBeTruthy();
    // Still present — no toggle exists to hide it
    expect(screen.getByText("Cost basis")).toBeTruthy();
  });
});
