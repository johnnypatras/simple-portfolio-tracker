import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangeTooltip } from "@/components/ui/change-tooltip";

describe("ChangeTooltip", () => {
  const base = { cur: "EUR", open: true };

  it("returns null when both FX and deposits are below threshold", () => {
    const { container } = render(
      <ChangeTooltip valueChange={100} fxValueChange={0.3} deposits={0.1} {...base} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders Prices + FX rows when FX is significant", () => {
    render(
      <ChangeTooltip valueChange={150} fxValueChange={-20} deposits={0} {...base} />,
    );
    expect(screen.getByText("Prices")).toBeInTheDocument();
    expect(screen.getByText("EUR/USD")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    // No Market row when deposits are zero
    expect(screen.queryByText("Market")).not.toBeInTheDocument();
  });

  it("shows USD/EUR label when currency is USD", () => {
    render(
      <ChangeTooltip valueChange={100} fxValueChange={5} deposits={0} cur="USD" open />,
    );
    expect(screen.getByText("USD/EUR")).toBeInTheDocument();
  });

  it("renders Market + Deposits rows when deposits are significant", () => {
    render(
      <ChangeTooltip valueChange={500} fxValueChange={0} deposits={200} {...base} />,
    );
    expect(screen.getByText("Market")).toBeInTheDocument();
    expect(screen.getByText("Deposits")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    // Prices row suppressed when FX is zero and deposits exist
    expect(screen.queryByText("Prices")).not.toBeInTheDocument();
  });

  it("shows Withdrawals label for negative deposits", () => {
    render(
      <ChangeTooltip valueChange={-100} fxValueChange={0} deposits={-300} {...base} />,
    );
    expect(screen.getByText("Withdrawals")).toBeInTheDocument();
    expect(screen.queryByText("Deposits")).not.toBeInTheDocument();
  });

  it("renders all rows when both FX and deposits are significant", () => {
    render(
      <ChangeTooltip valueChange={500} fxValueChange={-30} deposits={200} {...base} />,
    );
    expect(screen.getByText("Market")).toBeInTheDocument();
    expect(screen.getByText("Prices")).toBeInTheDocument();
    expect(screen.getByText("EUR/USD")).toBeInTheDocument();
    expect(screen.getByText("Deposits")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("renders deposit breakdown when multiple items provided", () => {
    render(
      <ChangeTooltip
        valueChange={1000}
        fxValueChange={0}
        deposits={500}
        depositBreakdown={[
          { name: "Alpha Bank", value: 300 },
          { name: "Revolut", value: 200 },
        ]}
        {...base}
      />,
    );
    expect(screen.getByText("Alpha Bank")).toBeInTheDocument();
    expect(screen.getByText("Revolut")).toBeInTheDocument();
  });

  it("shows deposit breakdown even for a single item", () => {
    render(
      <ChangeTooltip
        valueChange={1000}
        fxValueChange={0}
        deposits={500}
        depositBreakdown={[{ name: "Alpha Bank", value: 500 }]}
        {...base}
      />,
    );
    // Single-item breakdown is shown (always show breakdown when deposits exist)
    expect(screen.getByText("Alpha Bank")).toBeInTheDocument();
  });

  it("shows percentage when startValue is provided", () => {
    render(
      <ChangeTooltip
        valueChange={100}
        fxValueChange={10}
        deposits={0}
        startValue={1000}
        {...base}
      />,
    );
    // Total: 100/1000 = 10%
    expect(screen.getByText("(+10.0%)")).toBeInTheDocument();
  });

  it("omits percentage when startValue is zero or missing", () => {
    const { container } = render(
      <ChangeTooltip
        valueChange={100}
        fxValueChange={10}
        deposits={0}
        startValue={0}
        {...base}
      />,
    );
    // No percentage parentheticals
    expect(container.textContent).not.toMatch(/\(\+?\-?\d+\.?\d*%\)/);
  });

  it("formats values with plus sign for positive amounts", () => {
    const { container } = render(
      <ChangeTooltip valueChange={250} fxValueChange={50} deposits={0} {...base} />,
    );
    // The grid contains formatted values — positive ones should have "+"
    const grid = container.querySelector(".grid");
    expect(grid?.textContent).toContain("+€");
  });

  it("applies red color class for negative value changes", () => {
    const { container } = render(
      <ChangeTooltip valueChange={-500} fxValueChange={-50} deposits={0} {...base} />,
    );
    // Negative values get text-red-400 from changeColorClass
    const redElements = container.querySelectorAll(".text-red-400");
    expect(redElements.length).toBeGreaterThan(0);
  });

  it("shows expand button when deposit breakdown exceeds limit", async () => {
    const user = userEvent.setup();
    const breakdown = [
      { name: "Alpha Bank", value: 100 },
      { name: "Revolut", value: 80 },
      { name: "N26", value: 70 },
      { name: "Eurobank", value: 60 },
      { name: "Snappi", value: 50 },
      { name: "ING", value: 40 },
    ];

    render(
      <ChangeTooltip
        valueChange={1000}
        fxValueChange={0}
        deposits={400}
        depositBreakdown={breakdown}
        {...base}
      />,
    );

    // First 5 items visible
    expect(screen.getByText("Alpha Bank")).toBeInTheDocument();
    expect(screen.getByText("Snappi")).toBeInTheDocument();
    // 6th item hidden
    expect(screen.queryByText("ING")).not.toBeInTheDocument();
    // "+1 more" button shown
    expect(screen.getByText("+1 more")).toBeInTheDocument();

    // Expand
    await user.click(screen.getByText("+1 more"));
    expect(screen.getByText("ING")).toBeInTheDocument();
    expect(screen.getByText("Show less")).toBeInTheDocument();

    // Collapse
    await user.click(screen.getByText("Show less"));
    expect(screen.queryByText("ING")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("shows only FX row when deposits are zero and FX is significant", () => {
    render(
      <ChangeTooltip valueChange={200} fxValueChange={100} deposits={0} {...base} />,
    );
    expect(screen.getByText("EUR/USD")).toBeInTheDocument();
    expect(screen.getByText("Prices")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    // No deposit-related rows
    expect(screen.queryByText("Deposits")).not.toBeInTheDocument();
    expect(screen.queryByText("Withdrawals")).not.toBeInTheDocument();
    expect(screen.queryByText("Market")).not.toBeInTheDocument();
  });

  it("renders without layout issues for very large numbers", () => {
    const { container } = render(
      <ChangeTooltip valueChange={9999999} fxValueChange={500000} deposits={0} {...base} />,
    );
    // Grid renders successfully with large values
    const grid = container.querySelector(".grid");
    expect(grid).not.toBeNull();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Prices")).toBeInTheDocument();
    expect(screen.getByText("EUR/USD")).toBeInTheDocument();
  });
});
