import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssetIdentityStep } from "@/components/transactions/asset-identity-step";
import type { PickedAsset, CoinGeckoSearchResult, YahooSearchResult } from "@/lib/types";

// Minimal CoinGeckoSearchResult stub — only `id` is required by the component.
const CRYPTO_RAW: CoinGeckoSearchResult = {
  id: "usd-coin",
  name: "USD Coin",
  symbol: "usdc",
  thumb: "",
  large: "",
  market_cap_rank: null,
};

const PICK: PickedAsset = {
  ticker: "USDC",
  assetClass: "crypto",
  name: "USD Coin",
  raw: CRYPTO_RAW,
};

it("chain is a COMBOBOX accepting an arbitrary value (not a fixed select)", () => {
  const onChange = vi.fn();
  render(
    <AssetIdentityStep
      assetClass="crypto"
      picked={PICK}
      availableChains={["Ethereum", "Solana"]}
      existingChains={["Ethereum"]}
      existingAssets={[{ coingecko_id: "usd-coin", chain: "Ethereum" }]}
      value={{}}
      onChange={onChange}
    />,
  );
  const chain = screen.getByLabelText(/chain/i);
  fireEvent.change(chain, { target: { value: "Base" } }); // a chain NOT in the suggestion list
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ chain: "Base" }));
});

it("shows the multi-chain banner when the chosen chain isn't one already held", () => {
  render(
    <AssetIdentityStep
      assetClass="crypto"
      picked={PICK}
      availableChains={["Ethereum", "Solana"]}
      existingChains={["Ethereum"]}
      existingAssets={[{ coingecko_id: "usd-coin", chain: "Ethereum" }]}
      value={{ chain: "Solana" }}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByText(/already hold/i)).toBeInTheDocument();
  expect(screen.getByText(/Ethereum/)).toBeInTheDocument(); // names the held chain
});

it("APY + acquisition_method live behind an Advanced disclosure (collapsed by default)", () => {
  render(
    <AssetIdentityStep
      assetClass="crypto"
      picked={PICK}
      availableChains={["Solana"]}
      value={{}}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByLabelText(/apy/i)).not.toBeInTheDocument(); // hidden until expanded
  fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
  expect(screen.getByLabelText(/apy/i)).toBeInTheDocument();
});

describe("additional crypto identity tests", () => {
  it("onChange is called with the full value object when chain is changed", () => {
    const onChange = vi.fn();
    render(
      <AssetIdentityStep
        assetClass="crypto"
        picked={PICK}
        availableChains={["Ethereum"]}
        value={{ subcategory: "L1" }}
        onChange={onChange}
      />,
    );
    const chain = screen.getByLabelText(/chain/i);
    fireEvent.change(chain, { target: { value: "Ethereum" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ subcategory: "L1", chain: "Ethereum" }),
    );
  });

  it("does NOT show the multi-chain banner when the chosen chain is already held", () => {
    render(
      <AssetIdentityStep
        assetClass="crypto"
        picked={PICK}
        availableChains={["Ethereum", "Solana"]}
        existingChains={["Ethereum"]}
        existingAssets={[{ coingecko_id: "usd-coin", chain: "Ethereum" }]}
        value={{ chain: "Ethereum" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/already hold/i)).not.toBeInTheDocument();
  });

  it("does NOT show the multi-chain banner when no existing assets exist for this coin", () => {
    render(
      <AssetIdentityStep
        assetClass="crypto"
        picked={PICK}
        availableChains={["Ethereum"]}
        existingAssets={[{ coingecko_id: "bitcoin", chain: "Bitcoin" }]} // different coin
        value={{ chain: "Ethereum" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/already hold/i)).not.toBeInTheDocument();
  });

  it("subcategory field emits via onChange", () => {
    const onChange = vi.fn();
    render(
      <AssetIdentityStep
        assetClass="crypto"
        picked={PICK}
        availableChains={[]}
        value={{}}
        onChange={onChange}
      />,
    );
    const typeInput = screen.getByLabelText(/type/i);
    fireEvent.change(typeInput, { target: { value: "DeFi" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subcategory: "DeFi" }));
  });

  it("APY field emits numeric value via onChange after Advanced is expanded", () => {
    const onChange = vi.fn();
    render(
      <AssetIdentityStep
        assetClass="crypto"
        picked={PICK}
        availableChains={[]}
        value={{}}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    const apyInput = screen.getByLabelText(/apy/i);
    fireEvent.change(apyInput, { target: { value: "5.5" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ apy: 5.5 }));
  });

  it("APY field emits undefined (not NaN/0) when cleared after being set", () => {
    // Use a stateful wrapper so the controlled value propagates between events.
    const onChange = vi.fn();
    function Wrapper() {
      const [val, setVal] = React.useState<import("@/components/transactions/asset-identity-step").AssetIdentityValue>({});
      return (
        <AssetIdentityStep
          assetClass="crypto"
          picked={PICK}
          availableChains={[]}
          value={val}
          onChange={(v) => { setVal(v); onChange(v); }}
        />
      );
    }
    render(<Wrapper />);
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    const apyInput = screen.getByLabelText(/apy/i);
    fireEvent.change(apyInput, { target: { value: "5" } });
    fireEvent.change(apyInput, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ apy: undefined }));
  });

  it("acquisition method select emits via onChange after Advanced is expanded", () => {
    const onChange = vi.fn();
    render(
      <AssetIdentityStep
        assetClass="crypto"
        picked={PICK}
        availableChains={[]}
        value={{}}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    const methodSelect = screen.getByLabelText(/acquisition method/i);
    fireEvent.change(methodSelect, { target: { value: "staked" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ acquisitionMethod: "staked" }),
    );
  });

  it("stock branch renders a placeholder without crashing", () => {
    const STOCK_RAW: YahooSearchResult = {
      symbol: "AAPL",
      shortname: "Apple Inc.",
      longname: "Apple Inc.",
      quoteType: "EQUITY",
      exchDisp: "NASDAQ",
      exchange: "NMS",
    };
    const STOCK_PICK: PickedAsset = {
      ticker: "AAPL",
      assetClass: "stock",
      name: "Apple Inc.",
      raw: STOCK_RAW,
    };
    render(
      <AssetIdentityStep
        assetClass="stock"
        picked={STOCK_PICK}
        value={{}}
        onChange={vi.fn()}
      />,
    );
    // As long as it renders without throwing, the stock placeholder is valid.
    // No crash = pass.
  });
});
