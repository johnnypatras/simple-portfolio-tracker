import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EditInstitutionModal } from "@/components/accounts/edit-institution-modal";
import type { InstitutionWithRoles } from "@/lib/types";

/**
 * Bank-currency coverage for the edit-institution modal.
 *
 * The bank-currency field only renders when ADDING a bank role; the server
 * (`updateInstitutionRoles`) consumes `bank_currency` only inside its
 * `also_bank` branch to create a NEW sibling cash account. The modal used to
 * (a) narrow the field to a hardcoded EUR/USD <select> and (b) send
 * `bank_currency` unconditionally even when no bank role was being added.
 * Now: any-ISO via the shared CurrencyCodeSelect, and `bank_currency` is
 * omitted unless a bank role is actually being added — so an existing bank's
 * currency can never be touched from this path.
 */

// ── Mocks ────────────────────────────────────────────────

const updateInstitutionRoles = vi.fn();
const removeInstitutionRole = vi.fn();
const deleteInstitution = vi.fn();
const updateWallet = vi.fn();

vi.mock("@/lib/actions/institutions", () => ({
  updateInstitutionRoles: (id: string, opts: unknown) => updateInstitutionRoles(id, opts),
  removeInstitutionRole: (...args: unknown[]) => removeInstitutionRole(...args),
  deleteInstitution: (...args: unknown[]) => deleteInstitution(...args),
}));

vi.mock("@/lib/actions/wallets", () => ({
  updateWallet: (...args: unknown[]) => updateWallet(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Helpers ──────────────────────────────────────────────

function makeInstitution(roles: InstitutionWithRoles["roles"]): InstitutionWithRoles {
  return {
    id: "inst-1",
    user_id: "u-1",
    name: "Nordea",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    roles,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("EditInstitutionModal — bank currency", () => {
  beforeEach(() => {
    updateInstitutionRoles.mockReset();
    removeInstitutionRole.mockReset();
    deleteInstitution.mockReset();
    updateWallet.mockReset();
  });

  it("saving an institution that ALREADY has a bank sends no bank_currency", async () => {
    updateInstitutionRoles.mockResolvedValue(undefined);
    render(
      <EditInstitutionModal
        open
        onClose={vi.fn()}
        institution={makeInstitution(["bank"])}
        wallets={[]}
      />,
    );

    // hasBank → no bank-currency field is shown, no bank role being added.
    expect(
      screen.queryByRole("combobox", { name: "Bank account currency" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(updateInstitutionRoles).toHaveBeenCalled());
    const [, opts] = updateInstitutionRoles.mock.calls[0];
    expect(opts).toMatchObject({ also_bank: false });
    // The unchanged existing bank's currency must not even reach the server.
    expect(opts).not.toHaveProperty("bank_currency");
  });

  it("adding a bank role accepts any ISO via Other… (NOK)", async () => {
    updateInstitutionRoles.mockResolvedValue(undefined);
    render(
      <EditInstitutionModal
        open
        onClose={vi.fn()}
        institution={makeInstitution(["broker"])}
        wallets={[]}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Bank" }));

    const select = screen.getByRole("combobox", { name: "Bank account currency" });
    expect(select).toHaveValue("EUR");
    fireEvent.change(select, { target: { value: "__other__" } });
    const codeInput = screen.getByLabelText("Bank account currency code");
    fireEvent.change(codeInput, { target: { value: "NOK" } });
    fireEvent.blur(codeInput);

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(updateInstitutionRoles).toHaveBeenCalled());
    const [, opts] = updateInstitutionRoles.mock.calls[0];
    expect(opts).toMatchObject({ also_bank: true, bank_currency: "NOK" });
  });
});
