import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Both Sentry configs must list "ConcurrencyConflictError" in `ignoreErrors` so
 * the benign user-retryable optimistic-lock conflict (thrown by the position +
 * cash-account guarded writes, then re-captured by `captureAction`) does not
 * generate error-level Sentry noise.
 *
 * The configs only call `Sentry.init({...})` inline at import time (no exported
 * options object, and importing the module would boot Sentry), so this asserts
 * at the SOURCE level via a content read — the sanctioned form when the init
 * options aren't otherwise reachable. It is a regression guard: if either
 * `ignoreErrors` array drops the entry (or the error class is renamed without
 * updating the filter), this fails.
 */

const CONFIGS = ["sentry.server.config.ts", "sentry.edge.config.ts"] as const;

describe("Sentry ignoreErrors — ConcurrencyConflictError filtered in both runtimes", () => {
  for (const file of CONFIGS) {
    it(`${file} lists "ConcurrencyConflictError" in ignoreErrors`, () => {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      // The entry must live inside an ignoreErrors array (not merely a comment).
      const match = src.match(/ignoreErrors:\s*\[([^\]]*)\]/);
      expect(match, `${file} must declare an ignoreErrors array`).not.toBeNull();
      expect(match![1]).toContain("ConcurrencyConflictError");
    });
  }
});
