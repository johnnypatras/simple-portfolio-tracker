import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Component tests for the legacy adjustment migration card + button.
 *
 * The card is an async React Server Component. We test it by invoking
 * the component function with a mocked `previewLegacyAdjustmentMigration`,
 * awaiting the resolved JSX, then handing the element to RTL's `render`.
 *
 * The button is a regular client component — straight `render` works.
 */

const hoisted = vi.hoisted(() => ({
  previewLegacyAdjustmentMigration: vi.fn(),
  migrateLegacyAdjustmentFlags: vi.fn(),
  routerRefresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
}));

vi.mock("@/lib/actions/migrate-legacy-adjustments", () => ({
  previewLegacyAdjustmentMigration: hoisted.previewLegacyAdjustmentMigration,
  migrateLegacyAdjustmentFlags: hoisted.migrateLegacyAdjustmentFlags,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: hoisted.routerRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    error: hoisted.toastError,
    message: hoisted.toastMessage,
  },
}));

import { LegacyAdjustmentMigrationCard } from "@/components/settings/legacy-adjustment-migration-card";
import { LegacyAdjustmentMigrationButton } from "@/components/settings/legacy-adjustment-migration-button";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Card (server component) ───────────────────────────────────────────

describe("LegacyAdjustmentMigrationCard", () => {
  it("shows success state when count is 0", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 0,
      by_entity_type: {},
    });

    // Server components return Promises — await before passing to render.
    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    expect(
      screen.getByText(/No legacy entries to migrate\. Your data is already correct\./i),
    ).toBeInTheDocument();
    // Migrate button must NOT be rendered when count is 0.
    expect(screen.queryByRole("button", { name: /Migrate/i })).not.toBeInTheDocument();
  });

  it("displays the count + by-entity-type breakdown when count > 0", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 47,
      by_entity_type: {
        crypto_position: 12,
        stock_position: 30,
        cash_account: 5,
      },
    });

    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    // Total count headline.
    expect(screen.getByText(/47 entries to migrate/i)).toBeInTheDocument();

    // Per-entity-type breakdown rows.
    expect(screen.getByText("Crypto positions")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Stock positions")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("Cash accounts")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();

    // The client button must be rendered (count > 0).
    expect(screen.getByRole("button", { name: /Migrate 47 entries/i })).toBeInTheDocument();
  });

  it("renders the static explanation paragraph in both states", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 3,
      by_entity_type: { cash_account: 3 },
    });

    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    // Explanation should always appear regardless of count.
    expect(screen.getByText(/one-time migration/i)).toBeInTheDocument();
    expect(screen.getByText(/Migrate legacy adjustment flags/i)).toBeInTheDocument();
  });

  it("renders an error state (not a throw) when previewLegacyAdjustmentMigration throws", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockRejectedValue(new Error("DB connection failed"));

    // Must NOT throw — settings page must always render.
    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    expect(screen.getByText(/Could not check migration status/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Refresh page/i })).toBeInTheDocument();
    // An error condition must use role="alert", not role="status".
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not check migration status/i);
    // No migrate button in the error state.
    expect(screen.queryByRole("button", { name: /Migrate/i })).not.toBeInTheDocument();
    // Explanation heading still shows.
    expect(screen.getByText(/Migrate legacy adjustment flags/i)).toBeInTheDocument();
  });

  it("sorts breakdown entries by count descending with alphabetical fallback", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 20,
      by_entity_type: {
        cash_account: 5,
        crypto_position: 12,
        stock_position: 3,
      },
    });

    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    const rows = screen.getAllByRole("generic").filter((el) => el.className.includes("justify-between"));
    // First row should be the highest count (Crypto positions: 12).
    expect(rows[0]).toHaveTextContent("Crypto positions");
    expect(rows[0]).toHaveTextContent("12");
    // Second row: Cash accounts (5).
    expect(rows[1]).toHaveTextContent("Cash accounts");
    expect(rows[1]).toHaveTextContent("5");
  });
});

// ─── Button (client component) ─────────────────────────────────────────

describe("LegacyAdjustmentMigrationButton", () => {
  it("clicking the trigger opens the confirm panel", () => {
    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    // Trigger button visible by default.
    const trigger = screen.getByRole("button", { name: /Migrate 5 entries/i });
    fireEvent.click(trigger);

    // Confirm panel replaces the trigger.
    expect(screen.getByText(/Confirm migration/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, migrate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel returns to the trigger state without calling the action", () => {
    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: /Migrate 5 entries/i })).toBeInTheDocument();
    expect(hoisted.migrateLegacyAdjustmentFlags).not.toHaveBeenCalled();
  });

  it("confirming calls the server action and shows the success result", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 3,
      migrated: 3,
      pending: 0,
      errors: 0,
      remaining: 0,
      // Successful migrations are counted, not enumerated → details is empty.
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={3} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 3 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(hoisted.migrateLegacyAdjustmentFlags).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      // Scope to the visible panel — the persistent sr-only live region also
      // carries the result summary.
      expect(screen.getByText(/Migrated 3 entries/i, { ignore: ".sr-only" })).toBeInTheDocument();
    });
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Migrated 3 entries");
    expect(hoisted.routerRefresh).toHaveBeenCalled();
  });

  it("displays per-row errors (entity context + generic line, never raw error text) when errors > 0", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 4,
      migrated: 2,
      pending: 0,
      errors: 2,
      remaining: 0,
      // details now carries ERROR rows only, with no raw error_message —
      // the underlying error goes to Sentry, not the DOM.
      details: [
        { id: "id-3", entity_type: "cash_account", entity_name: "Broken Account" },
        { id: "id-4", entity_type: "stock_position", entity_name: "MYSTERY" },
      ],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={4} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 4 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(screen.getByText(/Migrated 2 of 4/i, { ignore: ".sr-only" })).toBeInTheDocument();
    });

    // Both error entries' names + types surface.
    expect(screen.getByText("Broken Account")).toBeInTheDocument();
    expect(screen.getByText("(cash_account)")).toBeInTheDocument();
    expect(screen.getByText("MYSTERY")).toBeInTheDocument();
    expect(screen.getByText("(stock_position)")).toBeInTheDocument();

    // Generic, non-leaking explanation appears once per error row.
    expect(
      screen.getAllByText(/Couldn’t migrate this entry — details logged for review\./i),
    ).toHaveLength(2);

    expect(hoisted.toastError).toHaveBeenCalledWith("Migrated 2 entries with 2 errors");
  });

  it("handles thrown server action errors with a non-fatal toast, refresh, and return to idle", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockRejectedValue(new Error("Network down"));

    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      // Copy must NOT imply total failure — a platform timeout may have made
      // durable per-row progress.
      expect(hoisted.toastError).toHaveBeenCalledWith(
        "Migration interrupted — some entries may have been migrated; refreshing…",
      );
    });
    // Refresh re-scopes the (reduced) candidate count so the user can resume.
    expect(hoisted.routerRefresh).toHaveBeenCalled();
    // Returns to idle (trigger button visible again).
    expect(screen.getByRole("button", { name: /Migrate 5 entries/i })).toBeInTheDocument();
  });

  it("rapid double-click on Yes migrate only calls the action once", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 2,
      migrated: 2,
      pending: 0,
      errors: 0,
      remaining: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={2} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 2 entries/i }));
    const confirmBtn = screen.getByRole("button", { name: "Yes, migrate" });
    // Simulate two rapid clicks in succession.
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(hoisted.migrateLegacyAdjustmentFlags).toHaveBeenCalledOnce();
    });
  });

  it("shows 'Nothing to migrate — already up to date' when migrated=0 and errors=0", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 0,
      migrated: 0,
      pending: 0,
      errors: 0,
      remaining: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={1} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 1 entry/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(hoisted.toastSuccess).toHaveBeenCalledWith("Nothing to migrate — already up to date");
    });
  });

  it("budget-limited run surfaces remaining count + a Continue button that re-invokes the action", async () => {
    // First run: budget fired → 2 migrated, 3 still to go.
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValueOnce({
      total_candidates: 5,
      migrated: 2,
      pending: 0,
      errors: 0,
      remaining: 3,
      details: [],
    });
    // Continue run: finishes the rest.
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValueOnce({
      total_candidates: 3,
      migrated: 3,
      pending: 0,
      errors: 0,
      remaining: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    // Partial state: "Migrated 2 of 5" + remaining line + Continue button.
    await waitFor(() => {
      expect(screen.getByText(/Migrated 2 of 5/i, { ignore: ".sr-only" })).toBeInTheDocument();
    });
    expect(screen.getByText(/3 entries still need migrating\./i)).toBeInTheDocument();
    expect(hoisted.toastMessage).toHaveBeenCalledWith(
      "Migrated 2 — 3 still to go. Click Continue.",
    );

    // Continue re-invokes the action directly (no second confirm step).
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(hoisted.migrateLegacyAdjustmentFlags).toHaveBeenCalledTimes(2);
    });
    // Result replaced (not accumulated) → clean done state, no remaining line.
    await waitFor(() => {
      expect(screen.getByText(/Migrated 3 entries/i, { ignore: ".sr-only" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("confirm panel moves focus to the primary action", async () => {
    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Yes, migrate" })).toHaveFocus();
    });
    // Confirm panel is an accessible group.
    expect(screen.getByRole("group", { name: "Confirm migration" })).toBeInTheDocument();
  });

  it("surfaces a pending count in the done panel and toast when some rows await price data", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 5,
      migrated: 5,
      // 2 of the 5 flipped but their cashflow landed `pending` (no price yet).
      pending: 2,
      errors: 0,
      remaining: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    // Done panel still reports full migration success in the headline…
    await waitFor(() => {
      expect(screen.getByText(/Migrated 5 entries/i, { ignore: ".sr-only" })).toBeInTheDocument();
    });
    // …plus an honest info line about the rows that aren't benchmark-visible yet.
    expect(
      screen.getByText(/2 entries awaiting price data — they’ll resolve automatically\./i),
    ).toBeInTheDocument();
    // Toast must not falsely claim full success — it appends the pending count.
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Migrated 5 entries (2 awaiting price data)");
  });

  it("uses singular copy for a single pending entry", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 3,
      migrated: 3,
      pending: 1,
      errors: 0,
      remaining: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={3} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 3 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(
        screen.getByText(/1 entry awaiting price data — they’ll resolve automatically\./i),
      ).toBeInTheDocument();
    });
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Migrated 3 entries (1 awaiting price data)");
  });

  it("renders a persistent sr-only live region whose text tracks the stage", async () => {
    // Hold the action open so we can observe the "migrating" message.
    let resolveMigration!: (value: unknown) => void;
    hoisted.migrateLegacyAdjustmentFlags.mockReturnValue(
      new Promise((resolve) => {
        resolveMigration = resolve;
      }),
    );

    const { container } = render(<LegacyAdjustmentMigrationButton candidateCount={4} />);

    // The polite live region exists and is empty in the idle stage (so it
    // pre-exists in the DOM before any message lands — the NVDA/JAWS contract).
    const liveRegion = container.querySelector('[role="status"][aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toHaveClass("sr-only");
    expect(liveRegion).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: /Migrate 4 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    // Migrating stage: same node, updated text.
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent("Migrating entries…");
    });
    // The visual migrating panel itself must NOT carry a redundant live role:
    // there is exactly ONE element with role="status" (the persistent region).
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toBe(liveRegion);
    // The visible panel still shows the text (scoped past the sr-only region).
    expect(screen.getByText("Migrating entries…", { ignore: ".sr-only" })).toBeInTheDocument();

    resolveMigration({
      total_candidates: 4,
      migrated: 4,
      pending: 1,
      errors: 0,
      remaining: 0,
      details: [],
    });

    // Done stage: same node again, now carrying the result summary + pending note.
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent(
        "Migrated 4 entries. 1 entry awaiting price data.",
      );
    });
  });

  it("moves focus to the done-stage Done button when nothing remains", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 2,
      migrated: 2,
      pending: 0,
      errors: 0,
      remaining: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={2} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 2 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    // After the spinner unmounts the confirm button, focus must land on the
    // done panel's primary action (Done) — not fall to <body>.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    });
  });

  it("moves focus to the Continue button when a budget-limited run leaves work", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 5,
      migrated: 2,
      pending: 0,
      errors: 0,
      remaining: 3,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    // Continue is the primary action when there's more to migrate.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus();
    });
  });
});
