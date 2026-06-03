import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  renderAvgCostCell,
  renderUnrealizedCell,
  renderRealizedCell,
  renderTotalPnLCell,
  sumGroupPnL,
} from "@/lib/portfolio/pnl-cells";
import type { AssetPnL, CostBasisResult } from "@/lib/portfolio/cost-basis";
import { COST_COPY } from "@/lib/cost-basis-copy";

/**
 * Component tests for the shared P&L column renderers (Task 3.3b).
 *
 * These pure functions return JSX; we render each into a container and assert on
 * the produced text, color class, and the FX-divergence tooltip behaviour. EUR
 * is authoritative — the renderers ALWAYS read pnl.eur regardless of the
 * primaryCurrency arg; in USD mode they additionally carry the divergence title.
 */

function makeResult(over: Partial<CostBasisResult> = {}): CostBasisResult {
  return { avgCost: 0, costBasis: 0, realized: 0, unrealized: 0, totalPnL: 0, ...over };
}

function makePnl(eur: Partial<CostBasisResult>, usd: Partial<CostBasisResult> = {}): AssetPnL {
  return { eur: makeResult(eur), usd: makeResult(usd) };
}

/** Render a cell node and return its root element for assertions. */
function renderCell(node: React.ReactNode): HTMLElement {
  const { container } = render(<>{node}</>);
  return container;
}

describe("renderAvgCostCell", () => {
  it("renders '—' when there is no P&L entry", () => {
    expect(renderCell(renderAvgCostCell(undefined, "EUR")).textContent).toBe("—");
  });

  it("renders '—' when avgCost is 0 (no held units)", () => {
    expect(renderCell(renderAvgCostCell(makePnl({ avgCost: 0 }), "EUR")).textContent).toBe("—");
  });

  it("formats a €1+ avg cost as 2-decimal EUR currency", () => {
    const c = renderCell(renderAvgCostCell(makePnl({ avgCost: 123.4 }), "EUR"));
    expect(c.textContent).toContain("€123.40");
  });

  it("formats a sub-€1 avg cost with 6-decimal precision (crypto rule)", () => {
    const c = renderCell(renderAvgCostCell(makePnl({ avgCost: 0.012345 }), "EUR"));
    expect(c.textContent).toBe("€0.012345");
  });

  it("carries the FX-divergence tooltip in USD mode, none in EUR mode", () => {
    const usdSpan = renderCell(renderAvgCostCell(makePnl({ avgCost: 10 }), "USD")).querySelector("span");
    expect(usdSpan?.getAttribute("title")).toBe(COST_COPY.fxDivergenceTooltip);
    const eurSpan = renderCell(renderAvgCostCell(makePnl({ avgCost: 10 }), "EUR")).querySelector("span");
    expect(eurSpan?.getAttribute("title")).toBeNull();
  });

  it("ALWAYS reads the EUR pass even in USD mode (authoritative headline)", () => {
    const pnl = makePnl({ avgCost: 10 }, { avgCost: 11 });
    // USD mode still shows the EUR number (10), not the USD pass (11).
    expect(renderCell(renderAvgCostCell(pnl, "USD")).textContent).toContain("€10.00");
  });
});

describe("renderUnrealizedCell", () => {
  it("renders '—' when there is no P&L entry", () => {
    expect(renderCell(renderUnrealizedCell(undefined, "EUR")).textContent).toBe("—");
  });

  it("renders '—' when costBasis is 0 (nothing to be unrealized against)", () => {
    expect(renderCell(renderUnrealizedCell(makePnl({ unrealized: 50, costBasis: 0 }), "EUR")).textContent).toBe("—");
  });

  it("shows the € amount + % vs costBasis, colored green for a gain", () => {
    const c = renderCell(renderUnrealizedCell(makePnl({ unrealized: 200, costBasis: 1000 }), "EUR"));
    expect(c.textContent).toContain("€200.00");
    expect(c.textContent).toContain("+20.0%");
    expect(c.querySelector("span")?.className).toContain("text-emerald-400");
  });

  it("colors red for a loss", () => {
    const c = renderCell(renderUnrealizedCell(makePnl({ unrealized: -100, costBasis: 1000 }), "EUR"));
    expect(c.querySelector("span")?.className).toContain("text-red-400");
    expect(c.textContent).toContain("-10.0%");
  });
});

describe("renderRealizedCell", () => {
  it("renders '—' when realized is EXACTLY 0 (pure-hold lockdown)", () => {
    expect(renderCell(renderRealizedCell(makePnl({ realized: 0 }), "EUR")).textContent).toBe("—");
  });

  it("renders '—' when there is no P&L entry", () => {
    expect(renderCell(renderRealizedCell(undefined, "EUR")).textContent).toBe("—");
  });

  it("shows a non-zero realized gain, colored green", () => {
    const c = renderCell(renderRealizedCell(makePnl({ realized: 75 }), "EUR"));
    expect(c.textContent).toContain("€75.00");
    expect(c.querySelector("span")?.className).toContain("text-emerald-400");
  });

  it("shows a realized loss, colored red", () => {
    const c = renderCell(renderRealizedCell(makePnl({ realized: -30 }), "EUR"));
    expect(c.querySelector("span")?.className).toContain("text-red-400");
  });
});

describe("renderTotalPnLCell", () => {
  it("renders '—' when there is no P&L entry", () => {
    expect(renderCell(renderTotalPnLCell(undefined, "EUR")).textContent).toBe("—");
  });

  it("shows € + % when costBasis > 0", () => {
    const c = renderCell(renderTotalPnLCell(makePnl({ totalPnL: 150, costBasis: 1000 }), "EUR"));
    expect(c.textContent).toContain("€150.00");
    expect(c.textContent).toContain("+15.0%");
  });

  it("omits the % when costBasis is 0 (e.g. fully-realized position) but still shows €", () => {
    const c = renderCell(renderTotalPnLCell(makePnl({ totalPnL: 40, costBasis: 0 }), "EUR"));
    expect(c.textContent).toContain("€40.00");
    expect(c.textContent).not.toContain("%");
  });
});

describe("sumGroupPnL", () => {
  const pnlByAsset: Record<string, AssetPnL> = {
    "crypto:a": makePnl({ costBasis: 1000, realized: 100, unrealized: 200, totalPnL: 300, avgCost: 5 }),
    "crypto:b": makePnl({ costBasis: 500, realized: -50, unrealized: 50, totalPnL: 0, avgCost: 2 }),
  };

  it("sums the additive EUR fields across member keys", () => {
    const sum = sumGroupPnL(["crypto:a", "crypto:b"], pnlByAsset);
    expect(sum).toBeDefined();
    expect(sum!.eur.costBasis).toBe(1500);
    expect(sum!.eur.realized).toBe(50);
    expect(sum!.eur.unrealized).toBe(250);
    expect(sum!.eur.totalPnL).toBe(300);
  });

  it("forces avgCost to 0 (no group-level meaning → Avg Cost renders '—')", () => {
    const sum = sumGroupPnL(["crypto:a", "crypto:b"], pnlByAsset);
    expect(sum!.eur.avgCost).toBe(0);
    expect(renderCell(renderAvgCostCell(sum, "EUR")).textContent).toBe("—");
  });

  it("returns undefined when no member has a P&L entry", () => {
    expect(sumGroupPnL(["crypto:x", "crypto:y"], pnlByAsset)).toBeUndefined();
  });

  it("returns undefined when the map itself is absent", () => {
    expect(sumGroupPnL(["crypto:a"], undefined)).toBeUndefined();
  });

  it("skips missing members but still sums present ones", () => {
    const sum = sumGroupPnL(["crypto:a", "crypto:missing"], pnlByAsset);
    expect(sum!.eur.costBasis).toBe(1000); // only crypto:a contributed
  });
});
