import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleSnapshotBanner } from "@/components/dashboard/stale-snapshot-banner";

describe("StaleSnapshotBanner", () => {
  it("renders nothing when staleHours is null", () => {
    const { container } = render(<StaleSnapshotBanner staleHours={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when staleHours <= 26", () => {
    const { container } = render(<StaleSnapshotBanner staleHours={24} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber banner when staleHours > 26", () => {
    render(<StaleSnapshotBanner staleHours={30} />);
    expect(screen.getByText(/30 hours/i)).toBeTruthy();
    expect(screen.getByText(/daily update may have failed/i)).toBeTruthy();
  });

  it("renders with large hour count", () => {
    render(<StaleSnapshotBanner staleHours={72} />);
    expect(screen.getByText(/72 hours/i)).toBeTruthy();
  });
});
