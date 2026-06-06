/**
 * A benign, user-retryable optimistic-concurrency conflict: the row's guard
 * column (quantity / balance) changed between the read and the guarded write, so
 * the write matched 0 rows. The user simply retries; nothing is broken.
 *
 * Given a stable `name` so Sentry's `ignoreErrors` (InboundFilters) can drop it
 * by type instead of firing two error-level events per conflict (the wrapping
 * `captureAction` calls `Sentry.captureException`). The `name` is the robust
 * filter key — keep it in sync with the `ignoreErrors` entry in BOTH
 * sentry.server.config.ts and sentry.edge.config.ts.
 *
 * PURE module (no "use server", no imports) so it is safe to import from server
 * actions and from a config-assertion unit test alike.
 */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}
