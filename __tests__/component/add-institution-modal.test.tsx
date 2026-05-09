import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddInstitutionModal } from "@/components/accounts/add-institution-modal";

/**
 * Regression test for the bank-only path.
 *
 * Previously, when a user filled out the "Add Institution" modal and chose
 * Bank-only (unchecked Exchange, unchecked Broker, checked Bank), the code
 * called `createCashAccount` directly without an `institution_id` — so the
 * "institution" the user thought they were adding never existed; the cash
 * account was created free-floating with `institution_id: null`.
 *
 * The fix: bank-only branch now calls `findOrCreateInstitution(name)` first
 * and links the resulting cash account to that institution. This brings the
 * bank-only path into line with the wallet-only and broker-only paths
 * (which already create institutions via createWallet / createBroker
 * delegating to findOrCreateInstitution internally).
 */

// ── Mocks ────────────────────────────────────────────────

const findOrCreateInstitution = vi.fn();
const createCashAccount = vi.fn();
const createWallet = vi.fn();
const createBroker = vi.fn();

vi.mock("@/lib/actions/institutions", () => ({
  findOrCreateInstitution: (name: string) => findOrCreateInstitution(name),
}));

vi.mock("@/lib/actions/cash-accounts", () => ({
  createCashAccount: (input: unknown, opts?: unknown) => createCashAccount(input, opts),
}));

vi.mock("@/lib/actions/wallets", () => ({
  createWallet: (input: unknown, opts?: unknown) => createWallet(input, opts),
}));

vi.mock("@/lib/actions/brokers", () => ({
  createBroker: (input: unknown, opts?: unknown) => createBroker(input, opts),
}));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Tests ────────────────────────────────────────────────

describe("AddInstitutionModal — bank-only branch", () => {
  beforeEach(() => {
    findOrCreateInstitution.mockReset();
    createCashAccount.mockReset();
    createWallet.mockReset();
    createBroker.mockReset();
  });

  it("creates institution AND links cash account to it", async () => {
    findOrCreateInstitution.mockResolvedValue("inst-id-123");
    createCashAccount.mockResolvedValue("ca-id-456");

    render(<AddInstitutionModal open onClose={vi.fn()} />);

    // Fill institution name
    fireEvent.change(screen.getByLabelText("Institution Name"), {
      target: { value: "Alpha Bank" },
    });

    // Toggle Exchange off (it's on by default), toggle Bank on
    fireEvent.click(screen.getByRole("checkbox", { name: /Exchange/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Bank/i }));

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /Create Institution/i }));

    await waitFor(() => {
      expect(findOrCreateInstitution).toHaveBeenCalledWith("Alpha Bank");
      expect(createCashAccount).toHaveBeenCalledTimes(1);
    });

    // The cash account must be linked to the just-created institution
    const [cashInput] = createCashAccount.mock.calls[0];
    expect(cashInput).toMatchObject({
      institution_id: "inst-id-123",
      currency: "EUR",
      balance: 0,
    });

    // The other branches must NOT have run
    expect(createWallet).not.toHaveBeenCalled();
    expect(createBroker).not.toHaveBeenCalled();
  });

  it("falls back to 'Main Account' when bankAccountName is blank", async () => {
    findOrCreateInstitution.mockResolvedValue("inst-id-1");
    createCashAccount.mockResolvedValue("ca-id-1");

    render(<AddInstitutionModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Institution Name"), {
      target: { value: "Alpha Bank" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Exchange/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Bank/i }));

    // Leave bank account name blank → expect "Main Account" default
    fireEvent.click(screen.getByRole("button", { name: /Create Institution/i }));

    await waitFor(() => {
      expect(createCashAccount).toHaveBeenCalled();
    });

    const [input] = createCashAccount.mock.calls[0];
    expect(input).toMatchObject({ name: "Main Account" });
  });

  it("uses provided bankAccountName when given", async () => {
    findOrCreateInstitution.mockResolvedValue("inst-id-2");
    createCashAccount.mockResolvedValue("ca-id-2");

    render(<AddInstitutionModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Institution Name"), {
      target: { value: "Alpha Bank" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Exchange/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Bank/i }));

    // Bank-specific fields are now visible — fill the cash account name.
    const accountNameInput = await screen.findByLabelText("Account Name") as HTMLInputElement;
    fireEvent.change(accountNameInput, {
      target: { value: "Premium Savings" },
    });
    // Verify the input value actually updated (sanity check on the change event)
    expect(accountNameInput.value).toBe("Premium Savings");

    fireEvent.click(screen.getByRole("button", { name: /Create Institution/i }));

    await waitFor(() => {
      expect(createCashAccount).toHaveBeenCalled();
    });

    const [input] = createCashAccount.mock.calls[0];
    expect(input).toMatchObject({ name: "Premium Savings" });
  });
});
