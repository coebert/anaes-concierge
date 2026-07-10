import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";

/**
 * Regression: the admin wellbeing / attrition page previously issued a
 * single wide `.range(0, 19999)` against `leave_requests` without ordering.
 * Supabase's Data API caps a single response at `db-max-rows` (1000 by
 * default), so it silently returned the first 1000 rows in an undefined
 * order. Recent leave rows for individual staff (e.g. an annual-leave
 * spell "a few weeks ago") could fall outside that window, and the
 * "days since last annual leave" driver would then be computed against
 * a much older spell — inflating the number to >300 days.
 *
 * `fetchAllPaged` must therefore:
 *   1. iterate ranges until a page returns fewer rows than pageSize,
 *   2. concatenate every page,
 *   3. surface PostgREST errors instead of swallowing them.
 */
describe("fetchAllPaged", () => {
  function buildFake(rows: number[], pageSize: number) {
    const calls: Array<[number, number]> = [];
    const build = () => ({
      range: (from: number, to: number) => {
        calls.push([from, to]);
        const slice = rows.slice(from, to + 1);
        return Promise.resolve({ data: slice, error: null });
      },
    });
    return { build, calls };
  }

  it("returns every row when the dataset spans multiple pages", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => i);
    const { build, calls } = buildFake(rows, 1000);
    const out = await fetchAllPaged<number>(build, 1000);
    expect(out).toHaveLength(2345);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(2344);
    // 3 pages: [0..999], [1000..1999], [2000..2999] (last is short → stop)
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("stops after a single page when the dataset fits", async () => {
    const rows = Array.from({ length: 42 }, (_, i) => i);
    const { build, calls } = buildFake(rows, 1000);
    const out = await fetchAllPaged<number>(build, 1000);
    expect(out).toHaveLength(42);
    expect(calls).toEqual([[0, 999]]);
  });

  it("throws when PostgREST returns an error", async () => {
    const build = () => ({
      range: async () => ({ data: null, error: { message: "boom" } }),
    });
    await expect(fetchAllPaged(build)).rejects.toThrow("boom");
  });
});
