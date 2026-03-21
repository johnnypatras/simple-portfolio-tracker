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

  it("handles error with digest property", () => {
    captureException.mockClear();
    const error = Object.assign(new Error("server error"), { digest: "abc123" });

    render(
      <DashboardError error={error} reset={vi.fn()} />,
    );

    expect(screen.getByText("Failed to load dashboard")).toBeInTheDocument();
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("renders and reports non-standard error objects", () => {
    captureException.mockClear();
    // Next.js wraps non-Error throws, but the component receives whatever is passed
    const error = { message: "string-based error", digest: "xyz" } as unknown as Error & { digest?: string };

    render(
      <DashboardError error={error} reset={vi.fn()} />,
    );

    expect(screen.getByText("Failed to load dashboard")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(captureException).toHaveBeenCalledWith(error);
  });
});
