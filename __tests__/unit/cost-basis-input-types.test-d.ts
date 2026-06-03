/**
 * Type-only structural-subset guard for CostBasisTxn.
 *
 * The engine consumes `getAssetTransactions` rows directly — `AssetTransactionRow`
 * must remain structurally assignable to `CostBasisTxn`. If this file fails to
 * compile, the structural-subset claim in cost-basis.ts has broken (a field was
 * added to `CostBasisTxn` that `AssetTransactionRow` no longer satisfies, or a
 * type was narrowed incompatibly).
 *
 * Validated by `npm run typecheck` (`tsc --noEmit`). NOT run under Vitest —
 * the `.test-d.ts` convention is tsc-only (see cash-account-input-types.test-d.ts).
 */
import type { CostBasisTxn } from "@/lib/portfolio/cost-basis";
import type { AssetTransactionRow } from "@/lib/portfolio/asset-transactions";

// AssetTransactionRow must remain assignable to CostBasisTxn — the engine consumes
// getAssetTransactions rows directly. If this fails to compile, the structural
// subset claim in cost-basis.ts has broken.
declare const row: AssetTransactionRow;
const _txn: CostBasisTxn = row;
void _txn;
