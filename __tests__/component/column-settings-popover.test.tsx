import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnSettingsPopover } from "@/components/ui/column-settings-popover";

const columns = [
  { key: "asset", label: "Asset", visible: true },
  { key: "price", label: "Price", visible: true },
  { key: "quantity", label: "Quantity", visible: false },
  { key: "value", label: "Value", visible: true },
];

describe("ColumnSettingsPopover", () => {
  it("renders the settings button but no popover initially", () => {
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTitle("Configure columns")).toBeInTheDocument();
    expect(screen.queryByText("Columns")).not.toBeInTheDocument();
  });

  it("opens popover on button click and shows all columns", async () => {
    const user = userEvent.setup();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));

    expect(screen.getByText("Columns")).toBeInTheDocument();
    expect(screen.getByText("Asset")).toBeInTheDocument();
    expect(screen.getByText("Price")).toBeInTheDocument();
    expect(screen.getByText("Quantity")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();
  });

  it("shows checkboxes matching visibility state", async () => {
    const user = userEvent.setup();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes[0]).toBeChecked(); // Asset
    expect(checkboxes[1]).toBeChecked(); // Price
    expect(checkboxes[2]).not.toBeChecked(); // Quantity
    expect(checkboxes[3]).toBeChecked(); // Value
  });

  it("calls onToggle when a checkbox is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={onToggle}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));
    await user.click(screen.getAllByRole("checkbox")[2]); // Quantity

    expect(onToggle).toHaveBeenCalledWith("quantity");
  });

  it("calls onMove with correct direction when arrows are clicked", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={onMove}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));

    // "Price" is the second visible column — both arrows should be enabled
    const moveDownButtons = screen.getAllByTitle("Move down");
    await user.click(moveDownButtons[0]); // Move "Asset" down

    expect(onMove).toHaveBeenCalledWith("asset", "down");
  });

  it("disables up arrow for first visible column and down arrow for last", async () => {
    const user = userEvent.setup();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));

    const moveUpButtons = screen.getAllByTitle("Move up");
    const moveDownButtons = screen.getAllByTitle("Move down");

    // First visible column (Asset): up disabled
    expect(moveUpButtons[0]).toBeDisabled();
    // Last visible column (Value): down disabled
    expect(moveDownButtons[moveDownButtons.length - 1]).toBeDisabled();
  });

  it("does not show arrows for hidden columns", async () => {
    const user = userEvent.setup();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));

    // 3 visible columns = 3 up arrows + 3 down arrows = 6 total arrow buttons
    const moveUpButtons = screen.getAllByTitle("Move up");
    const moveDownButtons = screen.getAllByTitle("Move down");
    expect(moveUpButtons).toHaveLength(3);
    expect(moveDownButtons).toHaveLength(3);
  });

  it("calls onReset when Reset button is clicked", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={onReset}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));
    await user.click(screen.getByText("Reset"));

    expect(onReset).toHaveBeenCalledOnce();
  });

  it("closes popover on Escape key", async () => {
    const user = userEvent.setup();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle("Configure columns"));
    expect(screen.getByText("Columns")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Columns")).not.toBeInTheDocument();
  });

  it("toggles popover open/closed on repeated button clicks", async () => {
    const user = userEvent.setup();
    render(
      <ColumnSettingsPopover
        columns={columns}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const btn = screen.getByTitle("Configure columns");

    await user.click(btn);
    expect(screen.getByText("Columns")).toBeInTheDocument();

    await user.click(btn);
    expect(screen.queryByText("Columns")).not.toBeInTheDocument();
  });
});
