import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const captureException = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureException,
}));

// Import after mock so the module picks up the mocked Sentry
const { default: DashboardError } = await import("@/app/dashboard/error");

describe("DashboardError", () => {
  it("renders the error heading text", () => {
    render(
      <DashboardError error={new Error("test crash")} reset={vi.fn()} />,
    );

    expect(screen.getByText("Failed to load dashboard")).toBeInTheDocument();
    expect(
      screen.getByText(/Something went wrong while loading this page/),
    ).toBeInTheDocument();
  });

  it("'Try again' button calls the reset prop", () => {
    const reset = vi.fn();

    render(
      <DashboardError error={new Error("test crash")} reset={reset} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("calls Sentry.captureException with the error on mount", () => {
    captureException.mockClear();
    const error = new Error("dashboard exploded");

    render(
      <DashboardError error={error} reset={vi.fn()} />,
    );

    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(error);
  });
});
