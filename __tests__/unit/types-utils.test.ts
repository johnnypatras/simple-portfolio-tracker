import { describe, it, expect } from "vitest";
import {
  parseWalletChains,
  isEvmChain,
  serializeChains,
  getWalletChainTokens,
  countryName,
  EVM_CHAINS,
} from "@/lib/types";

describe("parseWalletChains", () => {
  it('expands "evm" to all EVM chains', () => {
    const result = parseWalletChains("evm");
    expect(result).toEqual([...EVM_CHAINS]);
  });

  it("returns individual chains without expansion", () => {
    const result = parseWalletChains("Ethereum,Polygon");
    expect(result).toEqual(["Ethereum", "Polygon"]);
  });

  it("returns [] for null", () => {
    expect(parseWalletChains(null)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseWalletChains("")).toEqual([]);
  });

  it("expands evm and appends non-EVM without duplicates", () => {
    const result = parseWalletChains("evm,Solana");
    expect(result).toEqual([...EVM_CHAINS, "Solana"]);
    // No duplicates
    expect(new Set(result).size).toBe(result.length);
  });
});

describe("isEvmChain", () => {
  it('returns true for "Ethereum"', () => {
    expect(isEvmChain("Ethereum")).toBe(true);
  });

  it('returns false for "Solana"', () => {
    expect(isEvmChain("Solana")).toBe(false);
  });
});

describe("serializeChains", () => {
  it('collapses all EVM chains to "evm"', () => {
    expect(serializeChains([...EVM_CHAINS])).toBe("evm");
  });

  it('uses "evm" shorthand plus non-EVM chains', () => {
    const result = serializeChains([...EVM_CHAINS, "Solana", "Bitcoin"]);
    expect(result).toBe("evm,Solana,Bitcoin");
  });

  it("joins non-EVM chains without evm shorthand", () => {
    expect(serializeChains(["Solana", "Bitcoin"])).toBe("Solana,Bitcoin");
  });
});

describe("getWalletChainTokens", () => {
  it("returns raw tokens without expanding evm", () => {
    expect(getWalletChainTokens("evm,Solana")).toEqual(["evm", "Solana"]);
  });
});

describe("countryName", () => {
  it('returns "Greece" for code "GR"', () => {
    expect(countryName("GR")).toBe("Greece");
  });

  it("falls back to the code itself for unknown codes", () => {
    expect(countryName("INVALID")).toBe("INVALID");
  });
});
