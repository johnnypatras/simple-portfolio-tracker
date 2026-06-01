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

/**
 * Shape of a PostgREST error surfaced by `@supabase/postgrest-js`. Mirrors that
 * library's `PostgrestError` contract: `message` is always present and
 * `details`/`hint`/`code` are always present but nullable (`string | null`,
 * never `undefined`). Modeling them as required-nullable — rather than optional
 * — matches the real wire shape and avoids a spurious third "missing" state.
 * All four fields are preserved so the thrown error carries enough context for
 * Sentry / dev-tools triage without forcing every caller to log the raw error
 * object separately. The full original error is also attached via ES2022
 * `Error.cause` for the upstream stack chain.
 */
export type PaginatedError = {
  message: string;
  details: string | null;
  hint: string | null;
  code: string | null;
};

/**
 * Row count above which a paginated read is considered "unusually large" and
 * warrants a Sentry breadcrumb. At 1 000 rows/page this threshold is 5 full
 * pages — well beyond any normal single-user dataset (a heavy DCA user with
 * 10 years of daily entries stays comfortably below 4 000 rows). Crossing it
 * means either a pathological dataset or a missing filter, both of which are
 * worth an observability signal before they become a latency incident.
 */
const PAGINATION_WARN_ROWS = 5_000;

/** Options for {@link fetchAllPaginated}. */
export type FetchAllPaginatedOpts = {
  /**
   * Human-readable label surfaced in the Sentry breadcrumb when the row count
   * exceeds {@link PAGINATION_WARN_ROWS}. Defaults to `"unlabeled"` so the
   * breadcrumb is still emitted even for call sites that don't set a label.
   */
  label?: string;
};

export async function fetchAllPaginated<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: PaginatedError | null;
  }>,
  pageSize: number = 1000,
  opts?: FetchAllPaginatedOpts,
): Promise<T[]> {
  const all: T[] = [];
  // Loop is broken as soon as a short page arrives (rows.length < pageSize),
  // which is guaranteed eventually for any well-formed query. The boundary
  // case where total rows is an exact multiple of pageSize triggers one
  // extra empty round-trip then exits.
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) {
      // Surface full PostgREST diagnostics (PG code + hint) in the thrown
      // message — these are silently dropped if we only forwarded `.message`,
      // and they're the difference between a debuggable Sentry report and
      // hours of guessing in production. The raw error is also attached via
      // `cause` so upstream catch sites get the original stack/object too.
      const codeTag = error.code ? ` [${error.code}]` : "";
      const hintTag = error.hint ? ` (hint: ${error.hint})` : "";
      throw new Error(
        `Pagination query failed${codeTag}: ${error.message}${hintTag}`,
        { cause: error },
      );
    }
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  // Fire-and-forget breadcrumb when the row count crosses the warning threshold.
  // Dynamic import keeps Sentry out of the critical path — a Sentry failure or
  // absence never blocks the data read. The .catch(() => {}) ensures no
  // unhandled-rejection even if the module is unavailable (test env, edge runtime
  // without Sentry wired, etc.).
  if (all.length > PAGINATION_WARN_ROWS) {
    void import("@sentry/nextjs")
      .then((S) => {
        S.addBreadcrumb({
          category: "pagination",
          message: "large paginated read",
          level: "warning",
          data: { label: opts?.label ?? "unlabeled", rows: all.length },
        });
      })
      .catch(() => {});
  }
  return all;
}
