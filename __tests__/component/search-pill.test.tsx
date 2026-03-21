import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────

const setOpen = vi.fn();

vi.mock("@/components/ui/command-palette-provider", () => ({
  useCommandPalette: () => ({ setOpen }),
}));

// Import after mock
import { SearchPill } from "@/components/ui/search-pill";

// ── Tests ────────────────────────────────────────────────

describe("SearchPill", () => {
  it("renders search icon", () => {
    render(<SearchPill />);

    // Lucide Search renders an <svg> inside the button
    const button = screen.getByRole("button");
    const svg = button.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("shows keyboard shortcut text", () => {
    render(<SearchPill />);

    expect(screen.getByText("⌘K")).toBeInTheDocument();
  });

  it("calls setOpen(true) on click", () => {
    setOpen.mockClear();
    render(<SearchPill />);

    fireEvent.click(screen.getByRole("button"));

    expect(setOpen).toHaveBeenCalledOnce();
    expect(setOpen).toHaveBeenCalledWith(true);
  });
});
