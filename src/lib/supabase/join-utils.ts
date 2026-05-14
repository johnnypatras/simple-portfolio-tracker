/**
 * Extract the `name` field from a PostgREST joined relation value.
 *
 * Supabase's `.select("*, institutions(name), wallets(name), brokers(name)")`
 * returns the joined row as either a single object `{ name: "…" }` (when the
 * foreign key is single-valued and PostgREST can prove it) or an array
 * `[{ name: "…" }]` (when the generated types widen to the many-side shape,
 * even though runtime yields a single row). Handles both shapes, plus null
 * and edge cases, so UI code can treat joined display names uniformly.
 *
 * @example
 *   pickJoinedName(row.institutions) // "Alpha Bank" | null
 *   pickJoinedName(row.wallets)      // "Ledger"    | null
 */
export function pickJoinedName(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const first = v[0] as { name?: string } | undefined;
    return first?.name ?? null;
  }
  return (v as { name?: string }).name ?? null;
}

/**
 * Generic counterpart to `pickJoinedName` for joined records where the
 * caller needs more than just the `name` field. Same PostgREST quirk —
 * the generated types widen single-row foreign-key joins to arrays.
 *
 * Returns the joined row (or first element of the array) as `T`, or `null`
 * if the relation is null/empty.
 *
 * The `T extends Record<string, unknown>` constraint guards against
 * accidentally narrowing to a primitive — a caller writing
 * `pickJoinedRecord<string>(...)` would be a foot-gun since PostgREST
 * relation shapes are always objects.
 *
 * @example
 *   const sa = pickJoinedRecord<{ kind: string; currency: string }>(row.stock_assets);
 *   if (sa?.kind === "manual") { ... }
 */
export function pickJoinedRecord<T extends Record<string, unknown>>(v: unknown): T | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    return ((v[0] as T | undefined) ?? null);
  }
  if (typeof v !== "object") return null;
  return v as T;
}
