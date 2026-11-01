import { describe, expect, it } from "vitest";
import { drainPages, IncompleteResultError, PageFetchError } from "./paged-fetch-core";
import { fetchAllPages } from "@/features/analytics/fetch-all-pages";
import { fetchAllRowsPaged } from "@/features/audit/paginate";
import { fetchAllPaged } from "./supabase-chunked";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
function source(total: number, opts: { failAtOffset?: number; delayMs?: number } = {}) {
  const data = rows(total);
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.failAtOffset !== undefined && from >= opts.failAtOffset) return { data: null, error: { message: "boom" } };
    // emulate PostgREST's server-side 1000-row cap
    return { data: data.slice(from, Math.min(to + 1, from + 1000)), error: null };
  };
  return { fetchPage, calls };
}

describe("drainPages", () => {
  it("returns all rows above the 1000-row server cap (2,345 rows)", async () => {
    const s = source(2345);
    expect(await drainPages(s.fetchPage)).toHaveLength(2345);
  });
  it("handles >500 with a 500 page size", async () => {
    const s = source(1234);
    expect(await drainPages(s.fetchPage, { pageSize: 500 })).toHaveLength(1234);
  });
  it("below cap: complete, no probe", async () => {
    const s = source(10);
    expect(await drainPages(s.fetchPage, { pageSize: 5, maxRows: 20 })).toHaveLength(10);
    expect(s.calls.at(-1)).toEqual([10, 14]);
  });
  it("exactly at cap: one-row probe confirms complete", async () => {
    const s = source(20);
    expect(await drainPages(s.fetchPage, { pageSize: 5, maxRows: 20 })).toHaveLength(20);
    expect(s.calls.at(-1)).toEqual([20, 20]);
  });
  it("above cap: throws IncompleteResultError instead of returning a truncated list", async () => {
    const s = source(21);
    await expect(drainPages(s.fetchPage, { pageSize: 5, maxRows: 20 })).rejects.toBeInstanceOf(IncompleteResultError);
  });
  it("page-2 error is surfaced, not swallowed", async () => {
    const s = source(2500, { failAtOffset: 1000 });
    await expect(drainPages(s.fetchPage)).rejects.toBeInstanceOf(PageFetchError);
  });
  it("rejects zero/negative/non-integer sizes", async () => {
    const s = source(1);
    await expect(drainPages(s.fetchPage, { pageSize: 0 })).rejects.toThrow(RangeError);
    await expect(drainPages(s.fetchPage, { maxRows: 0 })).rejects.toThrow(RangeError);
    await expect(drainPages(s.fetchPage, { pageSize: 1.5 })).rejects.toThrow(RangeError);
  });
  it("works with delayed responses (sequential, ordered)", async () => {
    const s = source(25, { delayMs: 2 });
    const out = await drainPages(s.fetchPage, { pageSize: 10 });
    expect(out.map((r) => r.id)).toEqual(rows(25).map((r) => r.id));
  });
});

describe("wrappers propagate completeness", () => {
  it("fetchAllPages reports complete=false on cap overflow and on errors", async () => {
    const over = await fetchAllPages(source(21).fetchPage as never, 5, 20);
    expect(over.complete).toBe(false);
    expect(over.error?.code).toBe("INCOMPLETE_RESULT");
    const err = await fetchAllPages(source(2500, { failAtOffset: 1000 }).fetchPage as never);
    expect(err.complete).toBe(false);
    expect(err.data).toEqual([]);
    const ok = await fetchAllPages(source(1500).fetchPage as never);
    expect(ok).toMatchObject({ complete: true, error: null });
    expect(ok.data).toHaveLength(1500);
  });
  it("fetchAllRowsPaged throws above its safety cap and dedupes by key", async () => {
    await expect(fetchAllRowsPaged(source(21).fetchPage, { pageSize: 5, safetyCap: 20 })).rejects.toThrow(IncompleteResultError);
    const out = await fetchAllRowsPaged(source(1001).fetchPage, { rowKey: (r) => r.id });
    expect(out).toHaveLength(1001);
  });
  it("fetchAllPaged throws above maxRows", async () => {
    const s = source(21);
    await expect(fetchAllPaged(() => ({ range: s.fetchPage }), { pageSize: 5, maxRows: 20 })).rejects.toThrow(IncompleteResultError);
  });
});
