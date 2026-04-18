import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @sentry/nextjs BEFORE importing the module under test ────────────
// withServerActionInstrumentation is mocked to a pass-through so we can assert
// on the inner behavior (captureException call + re-throw) in isolation.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  withServerActionInstrumentation: vi.fn(async <R,>(_name: string, fn: () => Promise<R>) => fn()),
}));

import * as Sentry from "@sentry/nextjs";
import { captureAction, withSentry } from "@/lib/actions/with-sentry";

describe("captureAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the function result on success (no captureException)", async () => {
    const result = await captureAction("test.action", async () => 42);
    expect(result).toBe(42);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures AND re-throws the error on failure", async () => {
    const err = new Error("boom");
    await expect(
      captureAction("test.action", async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { action: "test.action" },
    });
  });

  it("tags the captured event with the correct action name", async () => {
    const err = new Error("specific-action-failure");
    await expect(
      captureAction("crypto.createCryptoAsset", async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { action: "crypto.createCryptoAsset" },
    });
  });

  it("wraps withServerActionInstrumentation with the given action name", async () => {
    await captureAction("wallets.createWallet", async () => "ok");
    expect(Sentry.withServerActionInstrumentation).toHaveBeenCalledWith(
      "wallets.createWallet",
      expect.any(Function),
    );
  });
});

describe("withSentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a wrapped function that forwards args and result on success", async () => {
    const add = withSentry("math.add", async (a: number, b: number) => a + b);
    expect(await add(2, 3)).toBe(5);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures and re-throws on failure with the correct action tag", async () => {
    const err = new Error("failure-in-wrapper");
    const failing = withSentry("math.fail", async () => {
      throw err;
    });

    await expect(failing()).rejects.toBe(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { action: "math.fail" },
    });
  });

  it("uses withServerActionInstrumentation with the given name", async () => {
    const fn = withSentry("test.wrapped", async () => 1);
    await fn();
    expect(Sentry.withServerActionInstrumentation).toHaveBeenCalledWith(
      "test.wrapped",
      expect.any(Function),
    );
  });
});
