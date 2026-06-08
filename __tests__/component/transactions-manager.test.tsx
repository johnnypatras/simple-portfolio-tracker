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
  executeTransfer: vi.fn(),
  getCashAccounts: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/actions/transactions", () => ({
  loadAssetTransactions: hoisted.loadAssetTransactions,
  addTransaction: hoisted.addTransaction,
  editTransaction: hoisted.editTransaction,
  markAsYield: hoisted.markAsYield,
}));

vi.mock("@/lib/actions/transfers", () => ({
  executeTransfer: hoisted.executeTransfer,
}));

vi.mock("@/lib/actions/cash-accounts", () => ({
  getCashAccounts: hoisted.getCashAccounts,
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
import type { AssetTransactionDisplayRow, CashAccount } from "@/lib/types";

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
  hoisted.executeTransfer.mockResolvedValue({ success: true, transferGroupId: "tg-1" });
  // One EUR cash account so the money-flow tracked option is available.
  hoisted.getCashAccounts.mockResolvedValue([
    {
      id: "acc-eur",
      user_id: "u1",
      institution_id: null,
      name: "Revolut EUR",
      currency: "EUR",
      balance: 5000,
      apy: 0,
      region: null,
      wallet_id: null,
      broker_id: null,
      last_was_adjustment: false,
      last_was_transfer: false,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      deleted_at: null,
    },
  ]);
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

    // Crypto buy now shows the money-flow question (C2a); the mocked
    // getCashAccounts makes tracked the default. This test exercises the plain
    // addTransaction refetch path, so route via "new money" (external).
    fireEvent.click(
      screen.getByRole("radio", { name: /new money entering the portfolio/i }),
    );

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

// ── Test 6: Money-flow routing (C2a) ──────────────────────────────────────────

describe("TransactionsManager — money-flow tracked routing (C2a)", () => {
  // A crypto target carrying a wallet option so the modal emits walletId (the
  // position side of the routed transfer).
  const CRYPTO_WITH_WALLET: OpenTransactionsTarget = {
    assetRef: { class: "crypto", assetId: "asset-a" },
    name: "Bitcoin",
    assetClass: "crypto",
    walletOptions: [{ id: "wallet-1", name: "Ledger" }],
  };
  const STOCK_WITH_BROKER: OpenTransactionsTarget = {
    assetRef: { class: "stock", assetId: "stock-a" },
    name: "VWCE",
    assetClass: "stock",
    brokerOptions: [{ id: "broker-1", name: "DEGIRO" }],
  };

  /** Open the add modal from an empty drawer and wait for the account select. */
  async function openAddModal(target: OpenTransactionsTarget) {
    hoisted.loadAssetTransactions.mockResolvedValue([]);
    render(<TransactionsManager target={target} onClose={vi.fn()} currency="EUR" />);
    const addFirstBtn = await screen.findByRole("button", { name: /add the first one/i });
    fireEvent.click(addFirstBtn);
    // The account select appears once getCashAccounts resolves + tracked default.
    await screen.findByRole("combobox", { name: /tracked account/i });
  }

  it("tracked BUY → executeTransfer called ONCE with the exact TransferInput; addTransaction NOT called", async () => {
    await openAddModal(CRYPTO_WITH_WALLET);

    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "0.5" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    // Within the 5000 EUR balance (amount > balance would overdraw → Save blocked).
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.executeTransfer).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.executeTransfer).toHaveBeenCalledWith({
      mode: "buy",
      source: { type: "cash_account", accountId: "acc-eur", amount: 4000 },
      destination: {
        type: "crypto_position",
        assetId: "asset-a",
        walletId: "wallet-1",
        quantity: 0.5,
      },
      effectiveDate: undefined,
    });
    expect(hoisted.addTransaction).not.toHaveBeenCalled();
  });

  it("tracked SELL → executeTransfer called with position source + cash destination", async () => {
    await openAddModal(CRYPTO_WITH_WALLET);

    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "0.25" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.executeTransfer).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.executeTransfer).toHaveBeenCalledWith({
      mode: "sell",
      source: {
        type: "crypto_position",
        assetId: "asset-a",
        walletId: "wallet-1",
        quantity: 0.25,
      },
      destination: { type: "cash_account", accountId: "acc-eur", amount: 9000 },
      effectiveDate: undefined,
    });
    expect(hoisted.addTransaction).not.toHaveBeenCalled();
  });

  it("tracked BUY for a STOCK → destination uses brokerId", async () => {
    await openAddModal(STOCK_WITH_BROKER);

    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "10" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.executeTransfer).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.executeTransfer).toHaveBeenCalledWith({
      mode: "buy",
      source: { type: "cash_account", accountId: "acc-eur", amount: 1000 },
      destination: {
        type: "stock_position",
        assetId: "stock-a",
        brokerId: "broker-1",
        quantity: 10,
      },
      effectiveDate: undefined,
    });
  });

  it("external BUY → addTransaction only, executeTransfer NOT called", async () => {
    await openAddModal(CRYPTO_WITH_WALLET);

    // Switch to external (new money entering).
    fireEvent.click(
      screen.getByRole("radio", { name: /new money entering the portfolio/i }),
    );
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.addTransaction).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.executeTransfer).not.toHaveBeenCalled();
    // addTransaction got the external cost + walletId, unchanged from today.
    const [, opts] = hoisted.addTransaction.mock.calls[0];
    expect(opts).toMatchObject({
      type: "buy",
      quantity: 1,
      walletId: "wallet-1",
      cost: { amount: 30000, currency: "EUR" },
    });
  });

  it("executeTransfer {success:false} → toast.error with the server message, no success toast", async () => {
    hoisted.executeTransfer.mockResolvedValue({
      success: false,
      error: "Insufficient balance in Revolut EUR",
    });
    await openAddModal(CRYPTO_WITH_WALLET);

    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "0.5" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.toastError).toHaveBeenCalledWith("Insufficient balance in Revolut EUR");
    });
    // No success toast — the modal stays open (no silent loss).
    expect(hoisted.toastSuccess).not.toHaveBeenCalledWith(expect.stringMatching(/recorded/i));
  });

  it("executeTransfer throws → toast.error with the thrown message", async () => {
    hoisted.executeTransfer.mockRejectedValue(new Error("network down"));
    await openAddModal(CRYPTO_WITH_WALLET);

    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "0.5" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.toastError).toHaveBeenCalledWith("network down");
    });
  });

  it("getCashAccounts failure → external-only (no account select), buy routes via addTransaction", async () => {
    hoisted.getCashAccounts.mockRejectedValue(new Error("fetch failed"));
    hoisted.loadAssetTransactions.mockResolvedValue([]);
    render(
      <TransactionsManager target={CRYPTO_WITH_WALLET} onClose={vi.fn()} currency="EUR" />,
    );
    const addFirstBtn = await screen.findByRole("button", { name: /add the first one/i });
    fireEvent.click(addFirstBtn);

    // Modal open; no tracked account select (degraded to external-only).
    await screen.findByLabelText(/quantity/i);
    expect(screen.queryByRole("combobox", { name: /tracked account/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(hoisted.addTransaction).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.executeTransfer).not.toHaveBeenCalled();
  });
});

// ── Test 7: Late cash-accounts fetch must NOT wipe the open form ──────────────

describe("TransactionsManager — late getCashAccounts resolution preserves form state", () => {
  // The lazy getCashAccounts fetch resolves AFTER the modal is already open and
  // mid-edit. The modal's reset effect must not re-fire on the cashAccounts
  // identity change, or every field (quantity/amount/date) gets wiped.
  const CRYPTO_WITH_WALLET: OpenTransactionsTarget = {
    assetRef: { class: "crypto", assetId: "asset-a" },
    name: "Bitcoin",
    assetClass: "crypto",
    walletOptions: [{ id: "wallet-1", name: "Ledger" }],
  };

  it("does not reset typed quantity/amount/date when the accounts promise resolves while the modal is open", async () => {
    const deferAccounts = deferred<CashAccount[]>();
    hoisted.getCashAccounts.mockReturnValue(deferAccounts.promise);
    hoisted.loadAssetTransactions.mockResolvedValue([]);

    render(
      <TransactionsManager target={CRYPTO_WITH_WALLET} onClose={vi.fn()} currency="EUR" />,
    );

    // Open the add modal while the accounts fetch is still pending.
    const addFirstBtn = await screen.findByRole("button", { name: /add the first one/i });
    fireEvent.click(addFirstBtn);
    const qtyInput = await screen.findByLabelText(/quantity/i);

    // With zero accounts at open time, the tracked radio is disabled and shows
    // the "no accounts" sub-text. Its later disappearance proves the loaded list
    // reached the modal (i.e. the component re-rendered on the new identity).
    expect(screen.getByText(/no tracked cash accounts yet/i)).toBeInTheDocument();

    // Type into every reset-tracked field before the fetch lands.
    fireEvent.change(qtyInput, { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1234" } });
    const dateInput = screen.getByLabelText(/date/i);
    fireEvent.change(dateInput, { target: { value: "2026-01-10" } });

    // The accounts promise resolves now — mid-edit.
    await act(async () => {
      deferAccounts.resolve([
        {
          id: "acc-eur",
          user_id: "u1",
          institution_id: null,
          name: "Revolut EUR",
          currency: "EUR",
          balance: 5000,
          apy: 0,
          region: null,
          wallet_id: null,
          broker_id: null,
          last_was_adjustment: false,
          last_was_transfer: false,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          deleted_at: null,
        },
      ]);
    });

    // Proof the loaded list reached the modal: the "no accounts" sub-text is gone
    // (the tracked radio is now enabled). The default is intentionally NOT flipped
    // to tracked — accounts loading after open must not touch any field.
    await waitFor(() => {
      expect(screen.queryByText(/no tracked cash accounts yet/i)).not.toBeInTheDocument();
    });

    // The typed values must survive the late resolution (no form wipe).
    expect((screen.getByLabelText(/quantity/i) as HTMLInputElement).value).toBe("0.5");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("1234");
    expect((screen.getByLabelText(/date/i) as HTMLInputElement).value).toBe("2026-01-10");
  });
});

// ── Test: openAdd opens the modal pre-typed (drawer hidden) ───────────────────

describe("TransactionsManager — openAdd target", () => {
  it("a target with openAdd opens the modal pre-typed (drawer hidden)", async () => {
    // NOTE: renderManager takes the target POSITIONALLY: renderManager(target, onClose?).
    renderManager({
      assetRef: { class: "crypto", assetId: "a1" },
      name: "BTC",
      assetClass: "crypto",
      walletOptions: [{ id: "w1", name: "Ledger" }],
      openAdd: "sell",
    });
    // Modal open (title "Add transaction — BTC"); drawer absent. The dash is an
    // EM-DASH (—, U+2014), NOT a hyphen — both titles use it. Copy it literally.
    expect(await screen.findByText(/add transaction — BTC/i)).toBeInTheDocument();
    expect(screen.queryByText(/^transactions — BTC$/i)).not.toBeInTheDocument();
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect.value).toBe("sell");
  });
});

describe("TransactionsManager — openAdd success dismissal (BUG1 regression)", () => {
  it("a successful add from an openAdd target dismisses entirely (drawer never opens)", async () => {
    hoisted.loadAssetTransactions.mockResolvedValue([]);
    hoisted.addTransaction.mockResolvedValue(undefined);
    const onClose = vi.fn();
    // openAdd opens the modal directly, pre-typed buy (no drawer behind).
    renderManager({ ...TARGET_A, openAdd: "buy" }, onClose);

    const qtyInput = await screen.findByLabelText(/quantity/i);
    fireEvent.change(qtyInput, { target: { value: "1" } });
    // Route via "new money" (external) → addTransaction success path.
    fireEvent.click(
      screen.getByRole("radio", { name: /new money entering the portfolio/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // The fix: an openAdd flow calls the top-level onClose on success, so the
    // parent clears the target and the history drawer never appears. Asserting
    // onClose was called IS the regression check — without the fix the success
    // branch never calls onClose (only the cancel path did). (The drawer would
    // stay mounted here regardless, since onClose is a spy that doesn't clear
    // the `target` prop the way the real parent table does — so we don't assert
    // on the drawer DOM in this harness.)
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
