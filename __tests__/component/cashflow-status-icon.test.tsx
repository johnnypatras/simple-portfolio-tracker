import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CashflowStatusIcon } from "@/components/ui/cashflow-status-icon";

describe("CashflowStatusIcon", () => {
  it("renders nothing when both statuses are null", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus={null} deltaStatus={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when statuses are complete", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus="complete" deltaStatus="complete" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber clock for pending status", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus="pending" deltaStatus={null} />);
    expect(container.querySelector(".text-amber-400")).toBeTruthy();
  });

  it("renders red alert for failed status", () => {
    const { container } = render(<CashflowStatusIcon cashflowStatus="failed" deltaStatus={null} />);
    expect(container.querySelector(".text-red-400")).toBeTruthy();
  });

  it("renders retry button when onRetry provided", () => {
    const { container } = render(
      <CashflowStatusIcon cashflowStatus="pending" deltaStatus={null} onRetry={async () => ({ success: true })} />
    );
    expect(container.querySelector("button")).toBeTruthy();
  });

  it("does not render retry button when onRetry omitted", () => {
    const { container } = render(
      <CashflowStatusIcon cashflowStatus="pending" deltaStatus={null} />
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
