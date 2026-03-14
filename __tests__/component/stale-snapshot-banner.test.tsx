import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleSnapshotBanner } from "@/components/dashboard/stale-snapshot-banner";

describe("StaleSnapshotBanner", () => {
  afterEach(() => vi.useRealTimers());

  it("renders nothing when latestSnapshotDate is undefined", () => {
    const { container } = render(<StaleSnapshotBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when snapshot is fresh (<= 26h)", () => {
    // 24 hours ago
    const date = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { container } = render(<StaleSnapshotBanner latestSnapshotDate={date} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber banner when snapshot is stale (> 26h)", () => {
    // 30 hours ago
    const date = new Date(Date.now() - 30 * 3_600_000).toISOString();
    render(<StaleSnapshotBanner latestSnapshotDate={date} />);
    expect(screen.getByText(/30 hours/i)).toBeTruthy();
    expect(screen.getByText(/daily update may have failed/i)).toBeTruthy();
  });

  it("renders with large staleness", () => {
    // 72 hours ago
    const date = new Date(Date.now() - 72 * 3_600_000).toISOString();
    render(<StaleSnapshotBanner latestSnapshotDate={date} />);
    expect(screen.getByText(/72 hours/i)).toBeTruthy();
  });
});
