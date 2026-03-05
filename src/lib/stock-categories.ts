import type { AssetCategory } from "@/lib/types";

/** Map pre-migration-022 DB category values to current enum */
const OLD_CAT_MAP: Record<string, AssetCategory> = {
  stock: "individual_stock",
  etf_ucits: "etf",
  etf_non_ucits: "etf",
  bond: "bond_fixed_income",
};

export function normalizeCategory(
  raw: string | null | undefined
): AssetCategory {
  if (!raw) return "individual_stock";
  return OLD_CAT_MAP[raw] ?? (raw as AssetCategory);
}
