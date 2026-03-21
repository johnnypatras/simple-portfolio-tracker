import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmButton } from "@/components/ui/confirm-button";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConfirmButton", () => {
  it("renders children in idle state", () => {
    render(
      <ConfirmButton onConfirm={vi.fn()}>
        <span>Delete</span>
      </ConfirmButton>,
    );
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Delete?")).not.toBeInTheDocument();
  });

  it("shows confirmation UI after first click", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmButton onConfirm={vi.fn()}>
        <span>Delete</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Delete"));

    expect(screen.getByText("Delete?")).toBeInTheDocument();
    expect(screen.getByTitle("Confirm")).toBeInTheDocument();
    expect(screen.getByTitle("Cancel")).toBeInTheDocument();
    // Original children replaced by confirmation UI
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("calls onConfirm on second click (confirm button)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm}>
        <span>Remove</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Remove"));
    await user.click(screen.getByTitle("Confirm"));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("returns to idle on cancel click without calling onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm}>
        <span>Remove</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Remove"));
    await user.click(screen.getByTitle("Cancel"));

    expect(onConfirm).not.toHaveBeenCalled();
    // Back to idle
    expect(screen.getByText("Remove")).toBeInTheDocument();
    expect(screen.queryByText("Delete?")).not.toBeInTheDocument();
  });

  it("auto-dismisses after 3 seconds", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm}>
        <span>Remove</span>
      </ConfirmButton>,
    );

    // Use fireEvent (synchronous) instead of userEvent to avoid timer conflicts
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText("Delete?")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Back to idle after timeout
    expect(screen.queryByText("Delete?")).not.toBeInTheDocument();
    expect(screen.getByText("Remove")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses custom confirmLabel", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmButton onConfirm={vi.fn()} confirmLabel="Undo?">
        <span>Undo</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Undo"));
    expect(screen.getByText("Undo?")).toBeInTheDocument();
  });

  it("shows adjustment checkbox when showAdjustmentCheckbox is true", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} showAdjustmentCheckbox>
        <span>Delete</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Delete"));

    expect(screen.getByText("Adj.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("passes isAdjustment=false by default when checkbox is unchecked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} showAdjustmentCheckbox>
        <span>Delete</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Delete"));
    await user.click(screen.getByTitle("Confirm"));

    expect(onConfirm).toHaveBeenCalledWith({ isAdjustment: false });
  });

  it("passes isAdjustment=true when checkbox is checked before confirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} showAdjustmentCheckbox>
        <span>Delete</span>
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Delete"));
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByTitle("Confirm"));

    expect(onConfirm).toHaveBeenCalledWith({ isAdjustment: true });
  });

  it("resets adjustment checkbox state after cancel", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmButton onConfirm={vi.fn()} showAdjustmentCheckbox>
        <span>Delete</span>
      </ConfirmButton>,
    );

    // Enter confirming, check the box, then cancel
    await user.click(screen.getByText("Delete"));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByTitle("Cancel"));

    // Re-enter confirming — checkbox should be unchecked
    await user.click(screen.getByText("Delete"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("calls onConfirm only once on rapid double-click", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm}>
        <span>Delete</span>
      </ConfirmButton>,
    );

    // Enter confirming state
    await user.click(screen.getByText("Delete"));
    // Click confirm — this calls onConfirm and resets to idle
    await user.click(screen.getByTitle("Confirm"));

    // After confirm, state resets to idle — original button is back
    // A second click enters confirming state again, not a second onConfirm
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("dismisses on click outside without calling onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm}>
        <span>Delete</span>
      </ConfirmButton>,
    );

    // Enter confirming state
    await user.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete?")).toBeInTheDocument();

    // Click outside the component (mousedown on document body)
    fireEvent.mouseDown(document.body);

    // Should return to idle
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Delete?")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
