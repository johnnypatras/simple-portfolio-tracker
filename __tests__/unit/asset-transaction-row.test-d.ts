/**
 * Type-only drift guard for AssetTransactionRow.
 *
 * `ACTIVITY_SELECT` is a plain string constant — TypeScript cannot verify that
 * the columns it names match the `AssetTransactionRow` interface. If a future
 * edit adds a key to `AssetTransactionRow` that doesn't exist as an
 * `activity_log` column (typo, rename, etc.), `fetchAllPaginated<AssetTransactionRow>`
 * would silently return `undefined` at that key at runtime.
 *
 * This file is validated by `npm run typecheck` (`tsc --noEmit`), which picks up
 * all `.test-d.ts` files under `__tests__/`. It does NOT run under Vitest —
 * the `.test-d.ts` convention is tsc-only (see `__tests__/unit/cash-account-input-types.test-d.ts`).
 *
 * The assertion: every key of `AssetTransactionRow` must be a key of the
 * generated `activity_log` Row type. If any key is unknown to the DB schema,
 * `_AssertKeysAreColumns` resolves to `false` and the `const _keysOk: true`
 * assignment fails to compile.
 *
 * We assert key membership only — NOT value-type equality — because Json columns
 * are intentionally narrowed to `unknown` in `AssetTransactionRow` (boundary
 * normalization convention) while the generated type uses `Json`. That divergence
 * is correct; it must not cause a false failure here.
 */
import type { AssetTransactionRow } from "@/lib/portfolio/asset-transactions";
import type { Database } from "@/types/database";

type ActivityLogRow = Database["public"]["Tables"]["activity_log"]["Row"];

// Every AssetTransactionRow key must be an activity_log column.
// If a key is renamed/removed from the DB (or a typo creeps in), this line fails to compile.
type _AssertKeysAreColumns = keyof AssetTransactionRow extends keyof ActivityLogRow
  ? true
  : false;
const _keysOk: _AssertKeysAreColumns = true;
void _keysOk;
