import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionsDrawer } from "@/components/transactions/transactions-drawer";
import type { TransactionDisplayRow, TransactionsDrawerProps } from "@/components/transactions/transactions-drawer";

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

let __rowSeq = 0;
function makeRow(overrides: Partial<TransactionDisplayRow> = {}): TransactionDisplayRow {
  return {
    id: `row-${++__rowSeq}`,
    kind: "buy",
    quantity: 1.5,
    amount: 1000,
    currency: "EUR",
    date: "2026-01-15",
    ...overrides,
  };
}

/**
 * Main fixture: 2 buys + 14 yields + 1 sell
 * Ordered oldest-first (yields are consecutive, rows 3-16).
 */
function makeMainFixture(): TransactionDisplayRow[] {
  const rows: TransactionDisplayRow[] = [
    makeRow({ id: "buy-1",  kind: "buy",  quantity: 2.0,  amount: 5000, currency: "EUR", date: "2026-01-01" }),
    makeRow({ id: "buy-2",  kind: "buy",  quantity: 1.0,  amount: 2500, currency: "EUR", date: "2026-01-10" }),
    makeRow({ id: "yld-1",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-02-01" }),
    makeRow({ id: "yld-2",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-02-08" }),
    makeRow({ id: "yld-3",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-02-15" }),
    makeRow({ id: "yld-4",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-02-22" }),
    makeRow({ id: "yld-5",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-03-01" }),
    makeRow({ id: "yld-6",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-03-08" }),
    makeRow({ id: "yld-7",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-03-15" }),
    makeRow({ id: "yld-8",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-03-22" }),
    makeRow({ id: "yld-9",  kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-03-29" }),
    makeRow({ id: "yld-10", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-04-05" }),
    makeRow({ id: "yld-11", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-04-12" }),
    makeRow({ id: "yld-12", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-04-19" }),
    makeRow({ id: "yld-13", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-04-26" }),
    makeRow({ id: "yld-14", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-05-03" }),
    makeRow({ id: "sell-1", kind: "sell", quantity: -0.5, amount: 1400, currency: "EUR", date: "2026-05-15" }),
  ];
  return rows;
}

/** Small fixture: only buys — used for no-match state (select Sells → no results). */
function makeBuysOnlyFixture(): TransactionDisplayRow[] {
  return [
    makeRow({ id: "b1", kind: "buy", quantity: 1.0, amount: 3000, currency: "EUR", date: "2026-03-01" }),
    makeRow({ id: "b2", kind: "buy", quantity: 0.5, amount: 1500, currency: "EUR", date: "2026-04-01" }),
  ];
}

function renderDrawer(overrides: Partial<TransactionsDrawerProps> = {}) {
  const onClose = vi.fn();
  const onEdit = vi.fn();
  const onAddFirst = vi.fn();
  const props: TransactionsDrawerProps = {
    isOpen: true,
    onClose,
    assetName: "BTC",
    assetClass: "crypto",
    rows: makeMainFixture(),
    onEdit,
    onAddFirst,
    ...overrides,
  };
  return { ...render(<TransactionsDrawer {...props} />), onClose, onEdit, onAddFirst };
}

// ── Test Group 1: Basic row rendering ─────────────────────────────────────────

describe("TransactionsDrawer — row rendering", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = renderDrawer({ isOpen: false });
    expect(container.innerHTML).toBe("");
  });

  it("renders the drawer panel with correct title when open", () => {
    renderDrawer();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Transactions — BTC")).toBeInTheDocument();
  });

  it("renders buy rows with kind badge, quantity, and amount", () => {
    renderDrawer({ rows: [
      makeRow({ id: "b1", kind: "buy", quantity: 2.5, amount: 5000, currency: "EUR", date: "2026-01-15" }),
    ]});
    // Badge
    expect(screen.getByText("Buy")).toBeInTheDocument();
    // Quantity (signed positive buy)
    expect(screen.getByText(/2\.50/)).toBeInTheDocument();
    // Amount formatted
    expect(screen.getByText(/5,000/)).toBeInTheDocument();
    // Date in locale-stable format
    expect(screen.getByText("2026-01-15")).toBeInTheDocument();
  });

  it("renders sell rows with kind badge and negative quantity", () => {
    renderDrawer({ rows: [
      makeRow({ id: "s1", kind: "sell", quantity: -1.0, amount: 3000, currency: "USD", date: "2026-02-20" }),
    ]});
    expect(screen.getByText("Sell")).toBeInTheDocument();
    expect(screen.getByText(/\-1\.00/)).toBeInTheDocument();
    expect(screen.getByText("2026-02-20")).toBeInTheDocument();
  });

  it("renders yield rows with 'Yield' badge and '—' for null amount", () => {
    renderDrawer({ rows: [
      makeRow({ id: "y1", kind: "yield", quantity: 0.005, amount: null, currency: "EUR", date: "2026-03-01" }),
    ]});
    // "Yield" appears in both the filter chip (button) and the badge (span).
    // getAllByText finds both; we assert at least one is a span (the badge).
    const yieldEls = screen.getAllByText("Yield");
    expect(yieldEls.some((el) => el.tagName === "SPAN")).toBe(true);
    // null amount → "—"
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders deposit and withdrawal badges for cash asset class", () => {
    renderDrawer({
      assetClass: "cash",
      rows: [
        makeRow({ id: "d1", kind: "deposit",    quantity: 500,  amount: 500,  currency: "EUR", date: "2026-01-01" }),
        makeRow({ id: "w1", kind: "withdrawal", quantity: -100, amount: 100,  currency: "EUR", date: "2026-01-10" }),
      ],
    });
    expect(screen.getByText("Deposit")).toBeInTheDocument();
    expect(screen.getByText("Withdrawal")).toBeInTheDocument();
  });

  it("renders transfer and adjustment badges with correct colors", () => {
    renderDrawer({ rows: [
      makeRow({ id: "t1", kind: "transfer",   quantity: 1.0, amount: null, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "a1", kind: "adjustment", quantity: 0.1, amount: null, currency: "EUR", date: "2026-01-02" }),
    ]});
    const xferBadge = screen.getByText("Transfer");
    const adjBadge = screen.getByText("Adjustment");
    expect(xferBadge).toHaveClass("text-teal-400");
    expect(adjBadge).toHaveClass("text-amber-400");
  });
});

// ── Test Group 2: Consecutive-yield grouping ───────────────────────────────────

describe("TransactionsDrawer — consecutive-yield grouping", () => {
  it("collapses 14 consecutive yields: shows first 2 + '+ 12 more' control", () => {
    renderDrawer(); // main fixture: 2 buys + 14 yields + 1 sell
    // First 2 yield rows visible by date
    expect(screen.getByText("2026-02-01")).toBeInTheDocument();
    expect(screen.getByText("2026-02-08")).toBeInTheDocument();
    // Collapsed control
    expect(screen.getByText("+ 12 more")).toBeInTheDocument();
    // Rows yld-3 through yld-14 are NOT yet in the DOM
    expect(screen.queryByText("2026-02-15")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-05-03")).not.toBeInTheDocument();
  });

  it("clicking '+ 12 more' reveals all remaining yield rows", () => {
    renderDrawer();
    fireEvent.click(screen.getByText("+ 12 more"));
    // All 14 yields should now be visible
    expect(screen.getByText("2026-02-15")).toBeInTheDocument();
    expect(screen.getByText("2026-05-03")).toBeInTheDocument();
    // Collapsed control gone; collapse affordance present
    expect(screen.queryByText("+ 12 more")).not.toBeInTheDocument();
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("clicking 'Show less' collapses back to 2 visible yields", () => {
    renderDrawer();
    fireEvent.click(screen.getByText("+ 12 more"));
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.getByText("+ 12 more")).toBeInTheDocument();
    expect(screen.queryByText("2026-02-15")).not.toBeInTheDocument();
  });

  it("does NOT collapse a run of exactly 2 consecutive yields", () => {
    renderDrawer({ rows: [
      makeRow({ id: "y1", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "y2", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-01-08" }),
    ]});
    // Both visible; no collapse control
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();
    expect(screen.getByText("2026-01-08")).toBeInTheDocument();
    expect(screen.queryByText(/\+ \d+ more/)).not.toBeInTheDocument();
  });

  it("does NOT collapse a run of exactly 1 consecutive yield", () => {
    renderDrawer({ rows: [
      makeRow({ id: "b1", kind: "buy",   quantity: 1,    amount: 1000, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "y1", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-01-08" }),
      makeRow({ id: "s1", kind: "sell",  quantity: -0.5, amount: 600,  currency: "EUR", date: "2026-01-15" }),
    ]});
    expect(screen.queryByText(/\+ \d+ more/)).not.toBeInTheDocument();
  });
});

// ── Test Group 3: Filter chips ─────────────────────────────────────────────────

describe("TransactionsDrawer — filter chips", () => {
  it("crypto: shows All / Buys / Sells / Yield filter chips", () => {
    renderDrawer({ assetClass: "crypto" });
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buys" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sells" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yield" })).toBeInTheDocument();
  });

  it("cash: shows All / Deposits / Withdrawals / Yield filter chips", () => {
    renderDrawer({ assetClass: "cash" });
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deposits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdrawals" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yield" })).toBeInTheDocument();
  });

  it("All chip is active by default (aria-pressed=true)", () => {
    renderDrawer();
    const allChip = screen.getByRole("button", { name: "All" });
    expect(allChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Buys" })).toHaveAttribute("aria-pressed", "false");
  });

  it("selecting 'Buys' filter shows only buy rows (2 in main fixture)", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Buys" }));
    // 2 buy badge spans
    const badges = screen.getAllByText("Buy");
    expect(badges).toHaveLength(2);
    // No sell badge spans (filter chip "Sells" is a button, not a badge span)
    expect(screen.queryByText("Sell")).not.toBeInTheDocument();
    // No yield badge spans — "Yield" chip button is still present but no span badge
    const yieldEls = screen.queryAllByText("Yield");
    expect(yieldEls.every((el) => el.tagName === "BUTTON")).toBe(true);
  });

  it("selecting 'Sells' filter shows only sell rows (1 in main fixture)", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    expect(screen.getAllByText("Sell")).toHaveLength(1);
    expect(screen.queryByText("Buy")).not.toBeInTheDocument();
    // No yield badge spans — "Yield" chip button is still present but no span badge
    const yieldEls = screen.queryAllByText("Yield");
    expect(yieldEls.every((el) => el.tagName === "BUTTON")).toBe(true);
  });

  it("selecting 'Yield' filter shows only yield rows (14 in main fixture)", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Yield" }));
    // 14 yield rows — some may be collapsed; badge should appear multiple times
    // At minimum the first 2 visible yields should show
    const badges = screen.getAllByText("Yield");
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Buy")).not.toBeInTheDocument();
    expect(screen.queryByText("Sell")).not.toBeInTheDocument();
  });

  it("selecting a chip marks it aria-pressed=true and deselects All", () => {
    renderDrawer();
    const buysChip = screen.getByRole("button", { name: "Buys" });
    fireEvent.click(buysChip);
    expect(buysChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a chip twice keeps it selected (no double-tap-to-reset behavior)", () => {
    renderDrawer();
    const buysChip = screen.getByRole("button", { name: "Buys" });
    fireEvent.click(buysChip);
    fireEvent.click(buysChip);
    // stays on Buys — reset only via explicit All click
    expect(buysChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });
});

// ── Test Group 3b: Transient-state reset on reopen ────────────────────────────

describe("TransactionsDrawer — state reset on reopen", () => {
  it("resets activeFilter to All when drawer closes and reopens", () => {
    const { rerender } = renderDrawer({ isOpen: true });

    // Select Sells chip
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    expect(screen.getByRole("button", { name: "Sells" })).toHaveAttribute("aria-pressed", "true");

    // Close the drawer (returns null — nothing in DOM)
    rerender(
      <TransactionsDrawer
        isOpen={false}
        onClose={vi.fn()}
        assetName="BTC"
        assetClass="crypto"
        rows={makeMainFixture()}
        onEdit={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Reopen — state should be reset to All
    rerender(
      <TransactionsDrawer
        isOpen={true}
        onClose={vi.fn()}
        assetName="BTC"
        assetClass="crypto"
        rows={makeMainFixture()}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Sells" })).toHaveAttribute("aria-pressed", "false");
  });
});

// ── Test Group 4: Empty state + no-match state ────────────────────────────────

describe("TransactionsDrawer — empty state", () => {
  it("renders empty-state copy and CTA when rows=[]", () => {
    const onAddFirst = vi.fn();
    renderDrawer({ rows: [], onAddFirst });
    expect(screen.getByText(/No transactions yet/i)).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: /Add the first one/i });
    expect(cta).toBeInTheDocument();
  });

  it("clicking the empty-state CTA calls onAddFirst", () => {
    const onAddFirst = vi.fn();
    renderDrawer({ rows: [], onAddFirst });
    fireEvent.click(screen.getByRole("button", { name: /Add the first one/i }));
    expect(onAddFirst).toHaveBeenCalledOnce();
  });

  it("does not crash with no onAddFirst prop in empty state", () => {
    const { container } = renderDrawer({ rows: [], onAddFirst: undefined });
    expect(container).toBeTruthy();
    expect(screen.getByText(/No transactions yet/i)).toBeInTheDocument();
  });
});

describe("TransactionsDrawer — no-match state", () => {
  it("shows no-match message + Clear filter button when filter yields no rows", () => {
    // buys-only fixture, select Sells → no results
    renderDrawer({ rows: makeBuysOnlyFixture() });
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    expect(screen.getByText(/No Sells transactions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear filter/i })).toBeInTheDocument();
  });

  it("clicking 'Clear filter' restores All view", () => {
    renderDrawer({ rows: makeBuysOnlyFixture() });
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    fireEvent.click(screen.getByRole("button", { name: /Clear filter/i }));
    // Back to All: buy badges visible
    expect(screen.getAllByText("Buy")).toHaveLength(2);
    // No-match message gone
    expect(screen.queryByText(/No Sells transactions/i)).not.toBeInTheDocument();
  });

  it("Yield filter on buys-only fixture also shows no-match", () => {
    renderDrawer({ rows: makeBuysOnlyFixture() });
    fireEvent.click(screen.getByRole("button", { name: "Yield" }));
    expect(screen.getByText(/No Yield transactions/i)).toBeInTheDocument();
  });
});

// ── Test Group 5: onEdit callback per row ────────────────────────────────────

describe("TransactionsDrawer — onEdit callback", () => {
  it("each row has a pencil (edit) button", () => {
    renderDrawer({ rows: [
      makeRow({ id: "r1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "r2", kind: "sell", quantity: -1, amount: 200, currency: "EUR", date: "2026-01-02" }),
    ]});
    const editButtons = screen.getAllByRole("button", { name: /Edit transaction/i });
    expect(editButtons).toHaveLength(2);
  });

  it("clicking a row's edit button calls onEdit with that row's id", () => {
    const onEdit = vi.fn();
    renderDrawer({
      onEdit,
      rows: [
        makeRow({ id: "row-alpha", kind: "buy",  quantity: 1,  amount: 1000, currency: "EUR", date: "2026-01-01" }),
        makeRow({ id: "row-beta",  kind: "sell", quantity: -1, amount: 500,  currency: "EUR", date: "2026-01-02" }),
      ],
    });
    const editButtons = screen.getAllByRole("button", { name: /Edit transaction/i });
    fireEvent.click(editButtons[0]);
    expect(onEdit).toHaveBeenCalledWith("row-alpha");
    fireEvent.click(editButtons[1]);
    expect(onEdit).toHaveBeenCalledWith("row-beta");
  });

  it("edit buttons are visible for collapsed yield rows after expanding", () => {
    const onEdit = vi.fn();
    renderDrawer({ onEdit }); // main fixture: 14 yields collapse
    // Expand the yield group
    fireEvent.click(screen.getByText("+ 12 more"));
    // Now all 14 + 2 buys + 1 sell = 17 rows have edit buttons
    const editButtons = screen.getAllByRole("button", { name: /Edit transaction/i });
    expect(editButtons.length).toBe(17);
  });
});

// ── Test Group 6: a11y / UI properties ────────────────────────────────────────

describe("TransactionsDrawer — accessibility", () => {
  it("panel has role=dialog + aria-modal=true", () => {
    renderDrawer();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("panel has aria-labelledby pointing at the title", () => {
    renderDrawer();
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const heading = document.getElementById(labelId!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toContain("Transactions — BTC");
  });

  it("close button has aria-label='Close'", () => {
    renderDrawer();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("clicking the close button calls onClose", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape does NOT fire when drawer is closed", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose, isOpen: false });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
