/**
 * Component tests for TransactionsManager — covers the three fixed bugs:
 *   1. Stale-response race (FIX 1+2): a late response from asset A is discarded
 *      when the target switches to asset B before A resolves.
 *   2. Edit rejection → toast (FIX 3): a thrown error from editTransaction is
 *      caught and shown via toast.error, not swallowed as an unhandled rejection.
 *   3. Refetch after add (FIX 1+2): a successful add triggers a second
 *      loadAssetTransactions call with the same assetRef.
 *
 * Strategy:
 *   - Mock the server actions (loadAssetTransactions, addTransaction,
 *     editTransaction) with vi.hoisted so they're in scope before imports.
 *   - Mock sonner and focus-trap-react for toast assertions and jsdom focus.
 *   - Use deferred promises for the race test to control resolution order.
 *   - Use waitFor / findBy for async assertions; NO fake timers.
 */

// Mocks must be hoisted before any imports.
const hoisted = vi.hoisted(() => ({
  loadAssetTransactions: vi.fn(),
  addTransaction: vi.fn(),
  editTransaction: vi.fn(),
  markAsYield: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/actions/transactions", () => ({
  loadAssetTransactions: hoisted.loadAssetTransactions,
  addTransaction: hoisted.addTransaction,
  editTransaction: hoisted.editTransaction,
  markAsYield: hoisted.markAsYield,
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    error: hoisted.toastError,
  },
}));

// focus-trap-react's focus management conflicts with jsdom — render children directly.
vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TransactionsManager } from "@/components/transactions/transactions-manager";
import type { OpenTransactionsTarget } from "@/components/transactions/transactions-manager";
import type { AssetTransactionDisplayRow } from "@/lib/actions/transactions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<AssetTransactionDisplayRow> = {}): AssetTransactionDisplayRow {
  return {
    id: "row-1",
    kind: "buy",
    quantity: 1.0,
    amount: 1000,
    currency: "EUR",
    date: "2026-01-15",
    isTransferLeg: false,
    isSplitChild: false,
    ...overrides,
  };
}

const TARGET_A: OpenTransactionsTarget = {
  assetRef: { class: "crypto", assetId: "asset-a" },
  name: "Bitcoin",
  assetClass: "crypto",
};

const TARGET_B: OpenTransactionsTarget = {
  assetRef: { class: "crypto", assetId: "asset-b" },
  name: "Ethereum",
  assetClass: "crypto",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Deferred promise — resolve/reject from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderManager(
  target: OpenTransactionsTarget | null,
  onClose = vi.fn(),
) {
  return render(
    <TransactionsManager
      target={target}
      onClose={onClose}
      currency="EUR"
    />,
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: resolves immediately with a single buy row.
  hoisted.loadAssetTransactions.mockResolvedValue([makeRow()]);
  hoisted.addTransaction.mockResolvedValue(undefined);
  hoisted.editTransaction.mockResolvedValue({ success: true });
  hoisted.markAsYield.mockResolvedValue({ updated: 1, skipped: 0 });
});

// ── Test 1: Stale-response race ───────────────────────────────────────────────

describe("TransactionsManager — stale-response race (FIX 1+2)", () => {
  it("discards a late response from asset A when target has already switched to B", async () => {
    const deferA = deferred<AssetTransactionDisplayRow[]>();
    const rowsB = [makeRow({ id: "b-row-1", kind: "buy", quantity: 2.0, amount: 2000 })];
    const deferB = deferred<AssetTransactionDisplayRow[]>();

    // First call (for asset A) → pending; second call (for asset B) → pending.
    hoisted.loadAssetTransactions
      .mockReturnValueOnce(deferA.promise)
      .mockReturnValueOnce(deferB.promise);

    const { rerender } = renderManager(TARGET_A);

    // Render with asset B — this triggers a second fetch with gen > 1.
    rerender(
      <TransactionsManager
        target={TARGET_B}
        onClose={vi.fn()}
        currency="EUR"
      />,
    );

    // Resolve B's fetch first.
    await act(async () => {
      deferB.resolve(rowsB);
    });

    // B's drawer should now be open — the title contains "Ethereum".
    await waitFor(() => {
      expect(screen.getByText(/Ethereum/)).toBeInTheDocument();
    });

    // B's row (quantity +2.00) should appear after deferB resolves.
    // formatQuantity(2.0, 6) → min-2/max-6 Intl → "2.00"; formatQty prepends "+".
    await waitFor(() => {
      expect(screen.getByText("+2.00")).toBeInTheDocument();
    });

    // Now resolve A's (stale) fetch — it must NOT overwrite the displayed rows.
    await act(async () => {
      deferA.resolve([makeRow({ id: "a-row-stale", kind: "sell", quantity: -5.0, amount: 9999 })]);
    });

    // Key assertion: A's stale negative quantity is NOT visible; B's row persists.
    // formatQty(-5.0) → "-5.00".
    await waitFor(() => {
      expect(screen.queryByText("-5.00")).not.toBeInTheDocument();
    });
    // B's row is still shown.
    expect(screen.getByText("+2.00")).toBeInTheDocument();
  });
});

// ── Test 2: Edit rejection → toast ────────────────────────────────────────────

describe("TransactionsManager — edit rejection surfaced via toast (FIX 3)", () => {
  it("calls toast.error when editTransaction throws, instead of swallowing", async () => {
    const editRow = makeRow({ id: "edit-me", kind: "buy", quantity: 1.0, amount: 500 });
    hoisted.loadAssetTransactions.mockResolvedValue([editRow]);
    hoisted.editTransaction.mockRejectedValue(new Error("FX conversion failed"));

    renderManager(TARGET_A);

    // Wait for drawer to show the row.
    const editBtn = await screen.findByRole("button", { name: /edit transaction/i });
    fireEvent.click(editBtn);

    // Modal should now be open — fill quantity so Save is enabled.
    const qtyInput = await screen.findByLabelText(/quantity/i);
    expect(qtyInput).toBeInTheDocument();

    // The modal pre-fills with the existing quantity.
    // Trigger submit by clicking Save button.
    const saveBtn = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    // toast.error should be called with the thrown message.
    await waitFor(() => {
      expect(hoisted.toastError).toHaveBeenCalledWith("FX conversion failed");
    });
  });
});

// ── Test 3: Refetch after add ─────────────────────────────────────────────────

describe("TransactionsManager — refetch after add (FIX 1+2)", () => {
  it("calls loadAssetTransactions a second time with the same assetRef after a successful add", async () => {
    hoisted.loadAssetTransactions.mockResolvedValue([]);
    hoisted.addTransaction.mockResolvedValue(undefined);

    renderManager(TARGET_A);

    // Wait for the initial load to complete (empty state).
    await waitFor(() => {
      expect(hoisted.loadAssetTransactions).toHaveBeenCalledTimes(1);
    });

    // The empty-state "Add the first one" CTA should be visible.
    const addFirstBtn = await screen.findByRole("button", { name: /add the first one/i });
    fireEvent.click(addFirstBtn);

    // Modal opens — fill a valid quantity.
    const qtyInput = await screen.findByLabelText(/quantity/i);
    fireEvent.change(qtyInput, { target: { value: "1" } });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    // After success, loadAssetTransactions should be called again with TARGET_A's assetRef.
    await waitFor(() => {
      expect(hoisted.loadAssetTransactions).toHaveBeenCalledTimes(2);
    });

    // Key assertion: both calls use the same assetRef.

    const calls = hoisted.loadAssetTransactions.mock.calls as unknown[][];
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
  });
});

// ── Test 4: Successful markAsYield → toast + refetch ─────────────────────────

describe("TransactionsManager — markAsYield success (updated + skipped toast)", () => {
  it("shows success toast with updated count and triggers a refetch", async () => {
    const buyRow = makeRow({ id: "buy-1", kind: "buy", quantity: 1, amount: 500 });
    hoisted.loadAssetTransactions.mockResolvedValue([buyRow]);
    hoisted.markAsYield.mockResolvedValue({ updated: 1, skipped: 0 });

    renderManager(TARGET_A);

    // Wait for the row to appear (drawer shows after initial load)
    await screen.findByRole("button", { name: /edit transaction/i });

    // Select the row via checkbox and click Mark as Yield → Confirm
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => {
      expect(hoisted.markAsYield).toHaveBeenCalledWith(["buy-1"]);
    });
    await waitFor(() => {
      expect(hoisted.toastSuccess).toHaveBeenCalledWith("1 marked as yield");
    });
    // Refetch: loadAssetTransactions called twice (initial + after yield)
    await waitFor(() => {
      expect(hoisted.loadAssetTransactions).toHaveBeenCalledTimes(2);
    });
  });

  it("includes skipped count in toast when skipped > 0", async () => {
    const buyRow = makeRow({ id: "buy-1", kind: "buy", quantity: 1, amount: 500 });
    hoisted.loadAssetTransactions.mockResolvedValue([buyRow]);
    hoisted.markAsYield.mockResolvedValue({ updated: 2, skipped: 1 });

    renderManager(TARGET_A);
    await screen.findByRole("button", { name: /edit transaction/i });

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => {
      expect(hoisted.toastSuccess).toHaveBeenCalledWith("2 marked as yield, 1 skipped");
    });
  });
});

// ── Test 5: Failed markAsYield → toast.error ─────────────────────────────────

describe("TransactionsManager — markAsYield rejection → toast.error", () => {
  it("shows toast.error when markAsYield throws", async () => {
    const buyRow = makeRow({ id: "buy-1", kind: "buy", quantity: 1, amount: 500 });
    hoisted.loadAssetTransactions.mockResolvedValue([buyRow]);
    hoisted.markAsYield.mockRejectedValue(new Error("Server error"));

    renderManager(TARGET_A);
    await screen.findByRole("button", { name: /edit transaction/i });

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => {
      expect(hoisted.toastError).toHaveBeenCalledWith("Server error");
    });
  });

  it("falls back to generic message when thrown value is not an Error", async () => {
    const buyRow = makeRow({ id: "buy-1", kind: "buy", quantity: 1, amount: 500 });
    hoisted.loadAssetTransactions.mockResolvedValue([buyRow]);
    hoisted.markAsYield.mockRejectedValue("some string error");

    renderManager(TARGET_A);
    await screen.findByRole("button", { name: /edit transaction/i });

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /Mark as Yield/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => {
      expect(hoisted.toastError).toHaveBeenCalledWith("Failed to mark as yield");
    });
  });
});
