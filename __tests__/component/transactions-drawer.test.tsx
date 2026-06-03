import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TransactionsDrawer } from "@/components/transactions/transactions-drawer";
import type { TransactionDisplayRow, TransactionsDrawerProps } from "@/components/transactions/transactions-drawer";
import { COST_COPY } from "@/lib/cost-basis-copy";

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

// ── Test Group 5b: loading skeleton ───────────────────────────────────────────

describe("TransactionsDrawer — loading state", () => {
  it("loading renders the pulse skeleton and NOT the empty-state copy", () => {
    const { container } = renderDrawer({ rows: [], loading: true });
    // Skeleton present: animate-pulse blocks.
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    // Empty-state copy suppressed while loading.
    expect(screen.queryByText(/No transactions yet/i)).not.toBeInTheDocument();
  });

  it("loading suppresses the normal row list", () => {
    // Even with rows present, loading shows the skeleton, not the rows.
    renderDrawer({ loading: true });
    expect(screen.queryByRole("button", { name: /Edit transaction/i })).not.toBeInTheDocument();
  });

  it("not loading (default) shows the empty-state when rows=[]", () => {
    renderDrawer({ rows: [] });
    expect(screen.getByText(/No transactions yet/i)).toBeInTheDocument();
  });
});

// ── Test Group 5c: header "+ Add" button ──────────────────────────────────────

describe("TransactionsDrawer — header add button", () => {
  it("renders the header '+ Add' button when onAdd is provided and fires it", () => {
    const onAdd = vi.fn();
    renderDrawer({ onAdd });
    const addBtn = screen.getByRole("button", { name: /Add transaction/i });
    expect(addBtn).toBeInTheDocument();
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("does NOT render the header add button when onAdd is absent", () => {
    renderDrawer({ onAdd: undefined });
    expect(screen.queryByRole("button", { name: /Add transaction/i })).not.toBeInTheDocument();
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

// ── Test Group 7: Multi-select — checkboxes render ────────────────────────────

describe("TransactionsDrawer — multi-select checkboxes render", () => {
  it("no checkboxes render when onMarkAsYield is not provided (backward compat)", () => {
    renderDrawer({ rows: [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })] });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("no action bar renders without onMarkAsYield even if rows exist", () => {
    renderDrawer({ rows: makeMainFixture() });
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark as Yield/i })).not.toBeInTheDocument();
  });

  it("checkboxes render for each visible row when onMarkAsYield is provided", () => {
    const rows = [
      makeRow({ id: "b1", kind: "buy",  quantity: 1,   amount: 100, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "s1", kind: "sell", quantity: -0.5, amount: 80,  currency: "EUR", date: "2026-01-02" }),
    ];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBe(2);
  });

  it("an eligible buy row has an enabled checkbox and can be selected", () => {
    const buyRow = makeRow({ id: "b1", kind: "buy", quantity: 1.5, amount: 1000, currency: "EUR", date: "2026-01-15" });
    renderDrawer({ rows: [buyRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);
    // After selection, action bar should show "1 selected"
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });

  it("an eligible deposit row (cash) has an enabled checkbox", () => {
    const depositRow = makeRow({ id: "d1", kind: "deposit", quantity: 500, amount: 500, currency: "EUR", date: "2026-01-01" });
    renderDrawer({ rows: [depositRow], assetClass: "cash", onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeDisabled();
  });
});

// ── Test Group 8: Multi-select — ineligible rows ──────────────────────────────

describe("TransactionsDrawer — ineligible rows have disabled checkboxes", () => {
  it("transfer-leg-flagged row has disabled checkbox with correct title", () => {
    const transferRow: TransactionDisplayRow & { isTransferLeg?: boolean } = {
      ...makeRow({ id: "t1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" }),
      isTransferLeg: true,
    };
    renderDrawer({ rows: [transferRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Part of a transfer");
  });

  it("split-child-flagged row has disabled checkbox with correct title", () => {
    const splitRow: TransactionDisplayRow & { isSplitChild?: boolean } = {
      ...makeRow({ id: "s1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" }),
      isSplitChild: true,
    };
    renderDrawer({ rows: [splitRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Split into dated parts");
  });

  it("yield row has disabled checkbox with 'Already yield' title", () => {
    const yieldRow = makeRow({ id: "y1", kind: "yield", quantity: 0.01, amount: null, currency: "EUR", date: "2026-01-01" });
    renderDrawer({ rows: [yieldRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Already yield");
  });

  it("sell row has disabled checkbox with correct title", () => {
    const sellRow = makeRow({ id: "s1", kind: "sell", quantity: -0.5, amount: 80, currency: "EUR", date: "2026-01-01" });
    renderDrawer({ rows: [sellRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Only acquisitions can be yield");
  });

  it("adjustment row has disabled checkbox with correct title", () => {
    const adjRow = makeRow({ id: "a1", kind: "adjustment", quantity: 0.1, amount: null, currency: "EUR", date: "2026-01-01" });
    renderDrawer({ rows: [adjRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Balance correction, not income");
  });

  it("transfer kind row has disabled checkbox with correct title", () => {
    const xferRow = makeRow({ id: "x1", kind: "transfer", quantity: 1, amount: null, currency: "EUR", date: "2026-01-01" });
    renderDrawer({ rows: [xferRow], onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("title", "Part of a transfer");
  });
});

// ── Test Group 9: Multi-select — selection bar ────────────────────────────────

describe("TransactionsDrawer — selection action bar", () => {
  it("shows '{n} selected' + Mark as Yield button + Clear when ≥1 selected", () => {
    const rows = [
      makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "b2", kind: "buy", quantity: 2, amount: 200, currency: "EUR", date: "2026-01-02" }),
    ];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    expect(screen.getByText(/2 selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark as Yield/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear/i })).toBeInTheDocument();
  });

  it("action bar does NOT render when no rows are selected", () => {
    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("Clear button empties the selection and hides the bar", () => {
    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
});

// ── Test Group 10: Multi-select — two-step confirm ────────────────────────────

describe("TransactionsDrawer — two-step confirm flow", () => {
  it("first click on 'Mark as Yield' shows the full COST_COPY.markAsYieldConfirm text", () => {
    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    expect(screen.getByText(COST_COPY.markAsYieldConfirm)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
  });

  it("Cancel in confirm state returns to selection bar without calling callback", () => {
    const onMarkAsYield = vi.fn();
    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    // Back to selection bar (no confirm text), callback not called
    expect(screen.queryByText(COST_COPY.markAsYieldConfirm)).not.toBeInTheDocument();
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    expect(onMarkAsYield).not.toHaveBeenCalled();
  });

  it("Confirm calls onMarkAsYield with exactly the selected ids", async () => {
    const onMarkAsYield = vi.fn().mockResolvedValue(undefined);
    const rows = [
      makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "b2", kind: "buy", quantity: 2, amount: 200, currency: "EUR", date: "2026-01-02" }),
    ];
    renderDrawer({ rows, onMarkAsYield });
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]); // select b1
    // Don't select b2
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => {
      expect(onMarkAsYield).toHaveBeenCalledWith(["b1"]);
    });
  });

  it("after Confirm resolves, selection is cleared and confirm state exits", async () => {
    const onMarkAsYield = vi.fn().mockResolvedValue(undefined);
    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => {
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      expect(screen.queryByText(COST_COPY.markAsYieldConfirm)).not.toBeInTheDocument();
    });
  });
});

// ── Test Group 11: Multi-select — selection clears on rows identity change ─────

describe("TransactionsDrawer — selection resets on rows identity change", () => {
  it("clears selection when rows prop identity changes (simulates post-refetch)", () => {
    const rowsV1 = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    const onMarkAsYield = vi.fn();

    const { rerender } = render(
      <TransactionsDrawer
        isOpen={true}
        onClose={vi.fn()}
        assetName="BTC"
        assetClass="crypto"
        rows={rowsV1}
        onEdit={vi.fn()}
        onMarkAsYield={onMarkAsYield}
      />,
    );

    // Select the row
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();

    // Simulate a refetch: new array reference with same content
    const rowsV2 = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    rerender(
      <TransactionsDrawer
        isOpen={true}
        onClose={vi.fn()}
        assetName="BTC"
        assetClass="crypto"
        rows={rowsV2}
        onEdit={vi.fn()}
        onMarkAsYield={onMarkAsYield}
      />,
    );

    // Selection bar should be gone
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
});

// ── Test Group 12: Multi-select — filter change clears selection (Fix 1) ──────

describe("TransactionsDrawer — filter change clears selection", () => {
  it("switching chips clears selection — no phantom '{n} selected' after filter change", () => {
    const rows = [
      makeRow({ id: "b1", kind: "buy",  quantity: 1,   amount: 100, currency: "EUR", date: "2026-01-01" }),
      makeRow({ id: "s1", kind: "sell", quantity: -0.5, amount: 80,  currency: "EUR", date: "2026-01-02" }),
    ];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });

    // Select the buy row under All
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]); // select b1 (buy)
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();

    // Switch to Sells chip — buy row hidden, selection must clear
    fireEvent.click(screen.getByRole("button", { name: "Sells" }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("the no-match 'Clear filter' button also resets selection", () => {
    // buys-only, select a row, then trigger no-match, then clear filter
    const rows = [
      makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" }),
    ];
    renderDrawer({ rows, onMarkAsYield: vi.fn() });

    // Select the buy
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();

    // Switch to Yield (no-match state) — selection clears via handleChipClick
    fireEvent.click(screen.getByRole("button", { name: "Yield" }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    // Clear filter button brings back All — still no phantom selection
    fireEvent.click(screen.getByRole("button", { name: /Clear filter/i }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
});

// ── Test Group 13: Multi-select — in-flight guard (Fix 2) ──────────────────

describe("TransactionsDrawer — Confirm in-flight guard", () => {
  it("rapid double-click on Confirm calls onMarkAsYield exactly once", async () => {
    // A promise that never resolves — simulates in-flight request.
    let resolveRequest!: () => void;
    const onMarkAsYield = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveRequest = resolve; }),
    );

    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield });

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));

    const confirmBtn = screen.getByRole("button", { name: /Confirm/i });
    // Rapid double-click
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    // Only one call despite two clicks
    expect(onMarkAsYield).toHaveBeenCalledTimes(1);

    // Resolve so the component can settle
    resolveRequest();
    await waitFor(() => {
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });
});

// ── Test Group 14: Multi-select — rejection contract (Fix 6) ──────────────

describe("TransactionsDrawer — rejection contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when onMarkAsYield rejects, the confirm state persists (retry possible)", async () => {
    // The component catches the rejection internally (to prevent an unhandled rejection)
    // but does NOT clear selectedIds / confirming — so the confirm sub-view stays mounted.
    const onMarkAsYield = vi.fn().mockRejectedValue(new Error("fail"));

    const rows = [makeRow({ id: "b1", kind: "buy", quantity: 1, amount: 100, currency: "EUR", date: "2026-01-01" })];
    renderDrawer({ rows, onMarkAsYield });

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    // Wait for onMarkAsYield to have been called
    await waitFor(() => expect(onMarkAsYield).toHaveBeenCalledTimes(1));

    // The confirm state must persist — Confirm button still visible (retry possible).
    // (selectionCount > 0 keeps the action bar mounted; confirm=true shows the sub-view;
    // neither is reset because setSelectedIds/setConfirming are after the await that threw.)
    expect(screen.getByRole("button", { name: /Confirm/i })).toBeInTheDocument();
    // The confirm copy is still present — the confirm sub-view is still mounted.
    expect(screen.getByText(COST_COPY.markAsYieldConfirm)).toBeInTheDocument();
  });
});
