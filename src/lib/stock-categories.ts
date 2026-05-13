import type { AssetCategory } from "@/lib/types";

/** Map pre-migration-022 DB category values to current enum */
const OLD_CAT_MAP: Record<string, AssetCategory> = {
  stock: "individual_stock",
  etf_ucits: "etf",
  etf_non_ucits: "etf",
  bond: "bond_fixed_income",
};

const VALID_CATEGORIES = new Set<AssetCategory>([
  "individual_stock",
  "etf",
  "bond_fixed_income",
  "private_equity",
  "other",
]);

export function normalizeCategory(
  raw: string | null | undefined
): AssetCategory {
  if (!raw) return "individual_stock";
  if (raw in OLD_CAT_MAP) return OLD_CAT_MAP[raw];
  if (VALID_CATEGORIES.has(raw as AssetCategory)) return raw as AssetCategory;
  return "individual_stock";
}
