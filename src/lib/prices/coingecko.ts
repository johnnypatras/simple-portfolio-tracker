import type { CoinGeckoSearchResult, CoinGeckoPriceData } from "@/lib/types";

const BASE_URL = "https://api.coingecko.com/api/v3";

function apiKey(): string {
  return process.env.NEXT_PUBLIC_COINGECKO_API_KEY ?? "";
}

function headers(): HeadersInit {
  const key = apiKey();
  return key ? { "x-cg-demo-api-key": key } : {};
}

/**
 * Search for coins by name or ticker.
 * Returns up to 10 results sorted by market cap rank.
 */
export async function searchCoins(
  query: string
): Promise<CoinGeckoSearchResult[]> {
  if (!query.trim()) return [];

  const url = `${BASE_URL}/search?query=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, { headers: headers(), next: { revalidate: 300 } });

  if (!res.ok) {
    console.error("[coingecko] Search failed:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return (data.coins ?? []).slice(0, 10).map(
    (c: Record<string, unknown>) => ({
      id: c.id as string,
      name: c.name as string,
      symbol: c.symbol as string,
      thumb: c.thumb as string,
      large: c.large as string,
      market_cap_rank: (c.market_cap_rank as number) ?? null,
    })
  );
}

/**
 * Fetch current prices for multiple coins in a single request.
 * Returns USD and EUR prices with 24h change percentages.
 */
export async function getPrices(
  coinIds: string[]
): Promise<CoinGeckoPriceData> {
  if (coinIds.length === 0) return {};

  const ids = coinIds.join(",");
  const url = `${BASE_URL}/simple/price?ids=${ids}&vs_currencies=usd,eur&include_24hr_change=true`;
  const res = await fetch(url, { headers: headers(), next: { revalidate: 60 } });

  if (!res.ok) {
    console.error("[coingecko] Price fetch failed:", res.status);
    return {};
  }

  return res.json();
}

// ── Coin detail (chain + categories) ──────────────────────

export interface CoinGeckoDetail {
  /** Display name from CoinGecko (e.g. "Bitcoin", "BNB") */
  name: string;
  asset_platform_id: string | null;
  categories: string[];
  /** Map of platform ID → contract address (for multi-chain tokens) */
  platforms: Record<string, string>;
}

/**
 * Fetch minimal detail for a single coin — just the platform + categories.
 * Used to auto-detect chain and subcategory when adding a new crypto asset.
 */
export async function getCoinDetail(coinId: string): Promise<CoinGeckoDetail | null> {
  const url = `${BASE_URL}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
  const res = await fetch(url, { headers: headers(), next: { revalidate: 3600 } });

  if (!res.ok) {
    console.error("[coingecko] Coin detail failed:", res.status);
    return null;
  }

  const data = await res.json();
  // Extract platforms, filtering out empty-string keys (CoinGecko quirk)
  const rawPlatforms = (data.platforms ?? {}) as Record<string, string>;
  const platforms: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawPlatforms)) {
    if (key.trim()) platforms[key] = val;
  }

  return {
    name: data.name ?? "",
    asset_platform_id: data.asset_platform_id ?? null,
    categories: Array.isArray(data.categories) ? data.categories : [],
    platforms,
  };
}

/**
 * Fetch the thumbnail image URL for a single coin.
 * Used to backfill image_url for assets created before icon storage was added.
 */
export async function getCoinImage(coinId: string): Promise<string | null> {
  const url = `${BASE_URL}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
  const res = await fetch(url, { headers: headers(), next: { revalidate: 86400 } });

  if (!res.ok) {
    console.error("[coingecko] Image fetch failed for", coinId, res.status);
    return null;
  }

  const data = await res.json();
  return (data.image?.thumb as string) ?? null;
}

// ── Mapping helpers ───────────────────────────────────────

/** Map CoinGecko asset_platform_id to a friendly chain name */
export const PLATFORM_TO_CHAIN: Record<string, string> = {
  ethereum: "Ethereum",
  "binance-smart-chain": "BNB Chain",
  "polygon-pos": "Polygon",
  "arbitrum-one": "Arbitrum",
  "optimistic-ethereum": "Optimism",
  avalanche: "Avalanche",
  solana: "Solana",
  base: "Base",
  fantom: "Fantom",
  cronos: "Cronos",
  near: "NEAR",
  "stacks-mainnet": "Stacks",
  tron: "Tron",
  stellar: "Stellar",
  cosmos: "Cosmos",
  polkadot: "Polkadot",
  cardano: "Cardano",
  algorand: "Algorand",
  sui: "Sui",
  aptos: "Aptos",
  celo: "Celo",
  mantle: "Mantle",
  blast: "Blast",
  linea: "Linea",
  "zksync-era": "zkSync",
  scroll: "Scroll",
};

/** Well-known L1 native coins (where asset_platform_id is null) */
const NATIVE_CHAIN_MAP: Record<string, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  solana: "Solana",
  cardano: "Cardano",
  polkadot: "Polkadot",
  avalanche: "Avalanche",
  near: "NEAR",
  cosmos: "Cosmos",
  algorand: "Algorand",
  fantom: "Fantom",
  sui: "Sui",
  aptos: "Aptos",
  tron: "Tron",
  stellar: "Stellar",
};

/** Map CoinGecko categories to our subcategory labels.
 *  First match wins — order matters (more specific first). */
const CATEGORY_TO_SUBCATEGORY: [RegExp, string][] = [
  [/stablecoin/i, "Stablecoin"],
  [/layer 1/i, "L1"],
  [/layer 2/i, "L2"],
  [/decentralized finance|defi/i, "DeFi"],
  [/meme/i, "Meme"],
  [/gaming|play.to.earn/i, "Gaming"],
  [/nft|non.fungible/i, "NFT"],
  [/real world asset|rwa/i, "RWA"],
  [/oracle/i, "Oracle"],
  [/exchange.based|exchange token/i, "Exchange Token"],
  [/privacy/i, "Privacy"],
  [/artificial intelligence|ai /i, "AI"],
  [/liquid staking/i, "Liquid Staking"],
  [/governance/i, "Governance"],
];

/** Derive a friendly chain name from CoinGecko detail.
 *  Priority: hardcoded override → CoinGecko display name → raw platform id */
export function inferChain(coinId: string, detail: CoinGeckoDetail): string {
  if (detail.asset_platform_id) {
    return PLATFORM_TO_CHAIN[detail.asset_platform_id] ?? detail.asset_platform_id;
  }
  // Native L1 coin — prefer our curated name, fall back to CoinGecko's name
  return NATIVE_CHAIN_MAP[coinId] ?? detail.name ?? "";
}

/** Get available chain names from a coin's platforms map.
 *  For native L1s (no platforms), returns the coin's own chain. */
export function getAvailableChains(coinId: string, detail: CoinGeckoDetail): string[] {
  const platformKeys = Object.keys(detail.platforms);
  if (platformKeys.length === 0) {
    // Native L1 coin — only chain is itself
    const native = NATIVE_CHAIN_MAP[coinId] ?? detail.name;
    return native ? [native] : [];
  }
  // Multi-chain token — map each platform to a friendly name
  const chains: string[] = [];
  for (const key of platformKeys) {
    const name = PLATFORM_TO_CHAIN[key] ?? key;
    if (!chains.includes(name)) chains.push(name);
  }
  return chains.sort();
}

/** Derive a subcategory from CoinGecko categories list */
export function inferSubcategory(categories: string[]): string {
  for (const cat of categories) {
    for (const [pattern, label] of CATEGORY_TO_SUBCATEGORY) {
      if (pattern.test(cat)) return label;
    }
  }
  return "";
}
