/**
 * Sentry wrappers for server actions.
 *
 * Uses `@sentry/nextjs`'s `withServerActionInstrumentation` helper which
 * starts a Sentry transaction for the action AND captures any uncaught
 * exception with a named tag — two features in one call.
 *
 * Two variants are exposed:
 *   • `withSentry(name, fn)` — returns a wrapped function; use at `export`
 *     time when the module can expose `export const name = withSentry(...)`.
 *   • `captureAction(name, fn)` — invoked inline in a function body; use
 *     when the `export async function name(...) {}` declaration must be
 *     preserved (signature clarity, named function for stack traces).
 *
 * Both set `tags.action` on the Sentry event so operators can filter
 * server-side failures by action name (e.g. `action:transfers.executeTransfer`).
 * PII is never added by these helpers; Sentry `sendDefaultPii: false` still
 * applies.
 */
import * as Sentry from "@sentry/nextjs";

type AnyAsyncFn<Args extends unknown[], R> = (...args: Args) => Promise<R>;

export function withSentry<Args extends unknown[], R>(
  actionName: string,
  fn: AnyAsyncFn<Args, R>,
): AnyAsyncFn<Args, R> {
  return async (...args: Args): Promise<R> => {
    return Sentry.withServerActionInstrumentation(
      actionName,
      async () => {
        try {
          return await fn(...args);
        } catch (err) {
          Sentry.captureException(err, { tags: { action: actionName } });
          throw err;
        }
      },
    );
  };
}

/**
 * Inline variant of `withSentry` — invoke this inside a function body to
 * keep the `export async function ...` signature unchanged.
 *
 * Usage:
 * ```ts
 * export async function createWallet(input: WalletInput): Promise<string> {
 *   return captureAction("wallets.createWallet", async () => {
 *     // body
 *   });
 * }
 * ```
 */
export async function captureAction<R>(
  actionName: string,
  fn: () => Promise<R>,
): Promise<R> {
  return Sentry.withServerActionInstrumentation(actionName, async () => {
    try {
      return await fn();
    } catch (err) {
      Sentry.captureException(err, { tags: { action: actionName } });
      throw err;
    }
  });
}
