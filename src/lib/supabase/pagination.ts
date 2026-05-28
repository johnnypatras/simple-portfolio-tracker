/**
 * Generic PostgREST pagination helper.
 *
 * PostgREST caps result size at `max_rows` (default 1000, both locally AND on
 * hosted Supabase) regardless of the client's `.limit()`. Any query that may
 * exceed 1000 rows MUST iterate via `.range(from, to)` until a short page
 * arrives — otherwise the query silently truncates and downstream logic sees a
 * partial dataset. Examples already in the wild:
 *   - historical_prices over multi-year ranges (~365+ rows/series × N series)
 *   - activity_log for users with heavy DCA history
 *   - crypto/stock positions or cash accounts for high-activity accounts
 *
 * The helper takes a builder callback that returns a Supabase query for a
 * given page window. Callers MUST include a deterministic `.order(...)` on the
 * underlying query so successive pages don't double-count or skip rows.
 *
 * The default `pageSize` matches the default PostgREST cap. The boundary case
 * where the result count is an exact multiple of `pageSize` is handled
 * correctly by the "rows.length < pageSize ⇒ stop" check: an exact multiple
 * triggers one extra (empty) round-trip, then exits.
 *
 * @example
 *   const rows = await fetchAllPaginated<MyRow>((from, to) =>
 *     supabase
 *       .from("activity_log")
 *       .select("entity_id, created_at")
 *       .eq("user_id", userId)
 *       .order("created_at", { ascending: true })
 *       .range(from, to),
 *   );
 */
export async function fetchAllPaginated<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  pageSize: number = 1000,
): Promise<T[]> {
  const all: T[] = [];
  // Loop is broken as soon as a short page arrives (rows.length < pageSize),
  // which is guaranteed eventually for any well-formed query. The boundary
  // case where total rows is an exact multiple of pageSize triggers one
  // extra empty round-trip then exits.
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}
