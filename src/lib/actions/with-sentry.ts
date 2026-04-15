/**
 * Sentry wrapper for server actions.
 *
 * Server actions that throw propagate to the Next.js error boundary where
 * the client-side Sentry SDK captures them — but the server-side context
 * (user_id, input shape, stack trace) is lost. This helper wraps a server
 * action so that unhandled exceptions are captured with a named tag before
 * re-throwing to the caller.
 *
 * Usage:
 * ```ts
 * export const executeTransfer = withSentry("transfers.execute", async (input: TransferInput) => {
 *   // ... action body, throws on failure
 * });
 * ```
 *
 * Design notes:
 * - The wrapper preserves the function's async return type.
 * - Errors are re-thrown after capture so callers still see them.
 * - A `tags.action` is set on the Sentry event for filtering.
 * - PII is not added here; Sentry `sendDefaultPii: false` still applies.
 */
import * as Sentry from "@sentry/nextjs";

type AnyAsyncFn<Args extends unknown[], R> = (...args: Args) => Promise<R>;

export function withSentry<Args extends unknown[], R>(
  actionName: string,
  fn: AnyAsyncFn<Args, R>,
): AnyAsyncFn<Args, R> {
  return async (...args: Args): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { action: actionName },
      });
      throw err;
    }
  };
}
