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
