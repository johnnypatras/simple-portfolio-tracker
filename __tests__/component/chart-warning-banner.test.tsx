import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChartWarningBanner } from "@/components/dashboard/chart-warning-banner";

describe("ChartWarningBanner", () => {
  it("renders nothing when counts are zero", () => {
    const { container } = render(<ChartWarningBanner pendingCount={0} failedCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber banner for pending only", () => {
    render(<ChartWarningBanner pendingCount={3} failedCount={0} />);
    expect(screen.getByText(/awaiting price data/i)).toBeTruthy();
  });

  it("renders red banner for failed only", () => {
    render(<ChartWarningBanner pendingCount={0} failedCount={2} />);
    expect(screen.getByText(/estimated values/i)).toBeTruthy();
  });

  it("renders both when both present", () => {
    render(<ChartWarningBanner pendingCount={1} failedCount={1} />);
    expect(screen.getByText(/awaiting price data/i)).toBeTruthy();
    expect(screen.getByText(/estimated values/i)).toBeTruthy();
  });
});
