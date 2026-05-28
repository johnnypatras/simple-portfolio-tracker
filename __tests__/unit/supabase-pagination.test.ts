import { describe, it, expect, vi } from "vitest";
import { fetchAllPaginated } from "@/lib/supabase/pagination";

describe("fetchAllPaginated — PostgREST max_rows handling (H2)", () => {
  it("returns an empty array when the first page is empty", async () => {
    const buildQuery = vi.fn(async () => ({ data: [] as number[], error: null }));
    const result = await fetchAllPaginated<number>(buildQuery, 1000);
    expect(result).toEqual([]);
    expect(buildQuery).toHaveBeenCalledTimes(1);
    expect(buildQuery).toHaveBeenCalledWith(0, 999);
  });

  it("stops after a short (partial) page", async () => {
    const buildQuery = vi.fn(async () => ({ data: [1, 2, 3], error: null }));
    const result = await fetchAllPaginated<number>(buildQuery, 1000);
    expect(result).toEqual([1, 2, 3]);
    expect(buildQuery).toHaveBeenCalledTimes(1);
  });

  it("handles the boundary case where total rows is an EXACT multiple of pageSize", async () => {
    // Boundary case the rest of the codebase trips over: PostgREST returns
    // exactly `pageSize` rows on the first page (= max_rows cap). A naive
    // implementation that stops on the first response would silently truncate.
    // fetchAllPaginated must keep paging until a short page arrives.
    const pageSize = 1000;
    const page1 = Array.from({ length: pageSize }, (_, i) => i);                 // 0..999
    const page2 = Array.from({ length: pageSize }, (_, i) => i + pageSize);      // 1000..1999
    const page3: number[] = [];                                                  // empty → stop
    let call = 0;
    const buildQuery = vi.fn(async () => {
      const data = call === 0 ? page1 : call === 1 ? page2 : page3;
      call++;
      return { data, error: null };
    });
    const result = await fetchAllPaginated<number>(buildQuery, pageSize);
    expect(result).toHaveLength(2 * pageSize);          // 2000 rows total
    expect(result[0]).toBe(0);
    expect(result[pageSize - 1]).toBe(pageSize - 1);    // last of page 1
    expect(result[pageSize]).toBe(pageSize);            // first of page 2
    expect(result[result.length - 1]).toBe(2 * pageSize - 1);
    // 3 calls: page1 (full) + page2 (full) + page3 (empty stop signal)
    expect(buildQuery).toHaveBeenCalledTimes(3);
    expect(buildQuery).toHaveBeenNthCalledWith(1, 0, pageSize - 1);
    expect(buildQuery).toHaveBeenNthCalledWith(2, pageSize, 2 * pageSize - 1);
    expect(buildQuery).toHaveBeenNthCalledWith(3, 2 * pageSize, 3 * pageSize - 1);
  });

  it("treats null data as empty (graceful) and stops", async () => {
    const buildQuery = vi.fn(async () => ({ data: null as number[] | null, error: null }));
    const result = await fetchAllPaginated<number>(buildQuery, 1000);
    expect(result).toEqual([]);
    expect(buildQuery).toHaveBeenCalledTimes(1);
  });

  it("throws (Error with message) when the builder returns an error", async () => {
    const buildQuery = vi.fn(async () => ({
      data: null as number[] | null,
      error: { message: "boom" },
    }));
    await expect(fetchAllPaginated<number>(buildQuery, 1000)).rejects.toThrow("boom");
  });

  it("uses the default pageSize of 1000 when not specified", async () => {
    const buildQuery = vi.fn(async () => ({ data: [] as number[], error: null }));
    await fetchAllPaginated<number>(buildQuery);
    expect(buildQuery).toHaveBeenCalledWith(0, 999); // 0..(1000-1)
  });

  it("aggregates rows across multiple non-boundary pages", async () => {
    const pageSize = 5;
    const page1 = [1, 2, 3, 4, 5];      // full
    const page2 = [6, 7, 8];            // short → stop
    let call = 0;
    const buildQuery = vi.fn(async () => {
      const data = call === 0 ? page1 : page2;
      call++;
      return { data, error: null };
    });
    const result = await fetchAllPaginated<number>(buildQuery, pageSize);
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(buildQuery).toHaveBeenCalledTimes(2);
  });
});
