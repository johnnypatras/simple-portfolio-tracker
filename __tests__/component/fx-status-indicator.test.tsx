import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FxStatusIndicator } from "@/components/ui/fx-status-indicator";

describe("FxStatusIndicator", () => {
  it("renders nothing when neither stale nor unavailable", () => {
    const { container } = render(<FxStatusIndicator stale={false} unavailable={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders amber icon when stale", () => {
    const { container } = render(<FxStatusIndicator stale={true} unavailable={false} />);
    expect(container.querySelector(".text-amber-400")).toBeTruthy();
  });

  it("renders red icon when unavailable", () => {
    const { container } = render(<FxStatusIndicator stale={false} unavailable={true} />);
    expect(container.querySelector(".text-red-400")).toBeTruthy();
  });

  it("renders red icon when both (unavailable takes precedence)", () => {
    const { container } = render(<FxStatusIndicator stale={true} unavailable={true} />);
    expect(container.querySelector(".text-red-400")).toBeTruthy();
  });
});
