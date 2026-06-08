import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssetPicker } from "@/components/transactions/asset-picker";
import type { AssetSearchResult } from "@/lib/hooks/use-asset-search";

const hoisted = vi.hoisted(() => ({ results: [] as AssetSearchResult[], loading: false }));
vi.mock("@/lib/hooks/use-asset-search", () => ({
  useAssetSearch: () => ({ results: hoisted.results, loading: hoisted.loading }),
}));

beforeEach(() => {
  hoisted.results = [];
  hoisted.loading = false;
});

const SOL: AssetSearchResult = {
  id: "solana", name: "Solana", symbol: "sol", thumb: "", large: "", market_cap_rank: 5,
};

describe("AssetPicker", () => {
  it("renders a search input for the class", () => {
    render(<AssetPicker assetClass="crypto" ownedTickers={new Set()} onPick={vi.fn()} />);
    expect(screen.getByPlaceholderText(/search crypto/i)).toBeInTheDocument();
  });

  it("shows results and emits a PickedAsset on click", () => {
    hoisted.results = [SOL];
    const onPick = vi.fn();
    render(<AssetPicker assetClass="crypto" ownedTickers={new Set()} onPick={onPick} />);
    fireEvent.change(screen.getByPlaceholderText(/search crypto/i), { target: { value: "sol" } });
    fireEvent.click(screen.getByRole("button", { name: /SOL/i }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ assetClass: "crypto", ticker: "SOL", name: "Solana", raw: SOL }),
    );
  });

  it("marks owned results with an Owned badge", () => {
    hoisted.results = [SOL];
    render(<AssetPicker assetClass="crypto" ownedTickers={new Set(["SOL"])} onPick={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search crypto/i), { target: { value: "sol" } });
    expect(screen.getByText("Owned")).toBeInTheDocument();
  });

  it("does NOT badge un-owned results", () => {
    hoisted.results = [SOL];
    render(<AssetPicker assetClass="crypto" ownedTickers={new Set(["BTC"])} onPick={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search crypto/i), { target: { value: "sol" } });
    expect(screen.queryByText("Owned")).not.toBeInTheDocument();
  });
});
