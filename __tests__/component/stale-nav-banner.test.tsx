import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StaleNavBanner } from "@/components/stocks/stale-nav-banner";

const TODAY = "2026-05-14";

beforeEach(() => {
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  localStorage.clear();
});

describe("StaleNavBanner", () => {
  it("renders nothing when there are no manual assets", () => {
    const { container } = render(<StaleNavBanner assets={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all manual assets have fresh NAVs", () => {
    // Latest NAV 10 days ago — well within the 45-day threshold
    const fresh = new Date(`${TODAY}T00:00:00Z`);
    fresh.setUTCDate(fresh.getUTCDate() - 10);
    const date = fresh.toISOString().split("T")[0];
    const { container } = render(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: date }]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders when a manual asset has NO NAV recorded", () => {
    render(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: null }]} />,
    );
    expect(screen.getByText(/1 manual NAV needs updating/i)).toBeInTheDocument();
    expect(screen.getByText(/ENXF \(no NAV\)/)).toBeInTheDocument();
  });

  it("renders when a NAV is older than 45 days", () => {
    const stale = new Date(`${TODAY}T00:00:00Z`);
    stale.setUTCDate(stale.getUTCDate() - 50);
    const date = stale.toISOString().split("T")[0];
    render(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: date }]} />,
    );
    expect(screen.getByText(/1 manual NAV needs updating/i)).toBeInTheDocument();
    expect(screen.getByText(/50 days ago/)).toBeInTheDocument();
  });

  it("does not render when NAV is exactly at the threshold (45 days)", () => {
    const boundary = new Date(`${TODAY}T00:00:00Z`);
    boundary.setUTCDate(boundary.getUTCDate() - 45);
    const date = boundary.toISOString().split("T")[0];
    const { container } = render(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: date }]} />,
    );
    // 45 days is NOT > 45 — should not trigger the banner
    expect(container.firstChild).toBeNull();
  });

  it("plural count and truncation when more than 3 stale assets", () => {
    const old = new Date(`${TODAY}T00:00:00Z`);
    old.setUTCDate(old.getUTCDate() - 60);
    const date = old.toISOString().split("T")[0];
    render(
      <StaleNavBanner
        assets={[
          { ticker: "A", name: "A", latestNavDate: date },
          { ticker: "B", name: "B", latestNavDate: date },
          { ticker: "C", name: "C", latestNavDate: date },
          { ticker: "D", name: "D", latestNavDate: date },
          { ticker: "E", name: "E", latestNavDate: date },
        ]}
      />,
    );
    expect(screen.getByText(/5 manual NAVs need updating/i)).toBeInTheDocument();
    expect(screen.getByText(/and 2 more/)).toBeInTheDocument();
  });

  it("dismiss button hides the banner and persists for today", () => {
    const stale = new Date(`${TODAY}T00:00:00Z`);
    stale.setUTCDate(stale.getUTCDate() - 60);
    const date = stale.toISOString().split("T")[0];
    const { rerender } = render(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: date }]} />,
    );
    fireEvent.click(screen.getByLabelText(/Dismiss banner/i));
    expect(screen.queryByText(/needs updating/i)).not.toBeInTheDocument();
    expect(localStorage.getItem("stale-nav-banner-dismissed-until")).toBe(TODAY);

    // Re-mount in same "day" — banner stays hidden
    rerender(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: date }]} />,
    );
    expect(screen.queryByText(/needs updating/i)).not.toBeInTheDocument();
  });

  it("reappears the next day after dismissal", () => {
    // Pretend the user dismissed yesterday
    const yesterday = new Date(`${TODAY}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    localStorage.setItem(
      "stale-nav-banner-dismissed-until",
      yesterday.toISOString().split("T")[0],
    );

    const stale = new Date(`${TODAY}T00:00:00Z`);
    stale.setUTCDate(stale.getUTCDate() - 60);
    const date = stale.toISOString().split("T")[0];
    render(
      <StaleNavBanner assets={[{ ticker: "ENXF", name: "EQT Nexus", latestNavDate: date }]} />,
    );
    expect(screen.getByText(/1 manual NAV needs updating/i)).toBeInTheDocument();
  });
});
