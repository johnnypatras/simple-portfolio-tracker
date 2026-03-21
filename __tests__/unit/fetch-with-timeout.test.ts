import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "@/lib/prices/fetch-with-timeout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("returns response when fetch succeeds within timeout", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await fetchWithTimeout("https://example.com/api");
    expect(result).toBe(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("passes init options through to fetch", async () => {
    const mockResponse = new Response("ok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };

    await fetchWithTimeout("https://example.com/api", init);
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("clears timer on successful fetch", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));

    await fetchWithTimeout("https://example.com/api");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("clears timer when fetch rejects immediately (network error)", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(fetchWithTimeout("https://example.com/api")).rejects.toThrow(
      "Failed to fetch",
    );
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("propagates network error from fetch", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    await expect(fetchWithTimeout("https://example.com/api")).rejects.toThrow(
      networkError,
    );
  });

  it("aborts fetch when timeout expires", async () => {
    vi.useFakeTimers();

    // fetch that never resolves
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );

    const promise = fetchWithTimeout("https://example.com/api", undefined, 5000);
    vi.advanceTimersByTime(5000);

    await expect(promise).rejects.toThrow("The operation was aborted.");
  });

  it("uses default timeout of 8000ms", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));

    await fetchWithTimeout("https://example.com/api");

    // Find the setTimeout call made by fetchWithTimeout (for the abort)
    const abortCall = setTimeoutSpy.mock.calls.find(
      (call) => call[1] === 8000,
    );
    expect(abortCall).toBeDefined();
  });

  it("uses custom timeout when provided", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));

    await fetchWithTimeout("https://example.com/api", undefined, 3000);

    const abortCall = setTimeoutSpy.mock.calls.find(
      (call) => call[1] === 3000,
    );
    expect(abortCall).toBeDefined();
  });
});
