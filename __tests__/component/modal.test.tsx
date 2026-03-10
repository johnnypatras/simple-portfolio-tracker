import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@/components/ui/modal";

describe("Modal", () => {
  it("renders nothing when open is false", () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()} title="Test">
        <p>Body</p>
      </Modal>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders title and children when open", () => {
    render(
      <Modal open onClose={vi.fn()} title="Add Asset">
        <p>Form content</p>
      </Modal>,
    );
    expect(screen.getByText("Add Asset")).toBeInTheDocument();
    expect(screen.getByText("Form content")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test">
        <p>Body</p>
      </Modal>,
    );

    // The X button is inside a button element
    const closeButtons = screen.getAllByRole("button");
    await user.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the overlay backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Test">
        <p>Body</p>
      </Modal>,
    );

    // The overlay is the outermost div with the fixed class
    const overlay = container.querySelector(".fixed");
    // Click directly on the overlay (not on the modal content)
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking inside the modal content", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.click(screen.getByText("Body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not attach keydown listener when closed", () => {
    const onClose = vi.fn();
    render(
      <Modal open={false} onClose={onClose} title="Test">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
