import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAssetSearch } from "@/lib/hooks/use-asset-search";

describe("useAssetSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not fetch for queries shorter than 2 chars", () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { result } = renderHook(() => useAssetSearch("crypto", "b"));
    vi.advanceTimersByTime(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it("debounces and hits the crypto endpoint, returning raw results", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [{ id: "solana", name: "Solana", symbol: "sol", thumb: "", large: "", market_cap_rank: 5 }],
    } as Response);

    const { result } = renderHook(({ q }) => useAssetSearch("crypto", q), {
      initialProps: { q: "sol" },
    });
    // Not fired before the debounce elapses.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Wrap the timer advance in act() so the async fetch-resolution setState is
    // flushed + captured. NB: do NOT use waitFor under fake timers — it polls on
    // real timers that never advance here, hanging until the test timeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/crypto/search?q=sol");
    expect(result.current.results).toHaveLength(1);
  });

  it("hits the stocks endpoint for the stock class", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true, json: async () => [],
    } as Response);
    renderHook(() => useAssetSearch("stock", "AAPL"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/stocks/search?q=AAPL");
  });
});
