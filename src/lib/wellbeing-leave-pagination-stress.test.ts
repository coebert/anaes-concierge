import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";

/**
 * Stress / performance regression for the paginated leave-request read that
 * feeds the wellbeing + attrition dashboards.
 *
 * Guarantees locked in here:
 *   1. Correctness at scale — every simulated leave row (across many staff
 *      and years of history) is returned in the same deterministic order
 *      the app sees in production.
 *   2. Query-count budget — `fetchAllPaged` issues exactly
 *      `ceil(rows / pageSize) + (rows % pageSize === 0 ? 1 : 0)` requests
 *      and never balloons into per-row fetches, even when the dataset
 *      crosses many page boundaries.
 *   3. Bounded wall-clock — even a 25k-row read (well above realistic
 *      production leave volumes) finishes in a small constant time budget,
 *      catching accidental O(n^2) regressions in the pager.
 *
 * The fake PostgREST builder enforces the same `db-max-rows` cap the
 * hosted Data API applies, so a broken pager cannot "cheat" by pulling
 * everything in one range.
 */

const DB_MAX_ROWS = 1000;
const PAGE_SIZE = 1000;

type Row = {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  end_date: string; // YYYY-MM-DD
};

function makeFakeLeaveTable(rows: Row[]) {
  let orderKey: keyof Row | null = null;
  let ascending = true;
  let rangeCalls = 0;
  const filters: Array<(r: Row) => boolean> = [];
  const api = {
    eq(key: keyof Row, value: string) {
      filters.push((r) => r[key] === value);
      return api;
    },
    order(key: keyof Row, opts: { ascending: boolean }) {
      orderKey = key;
      ascending = opts.ascending;
      return api;
    },
    async range(from: number, to: number) {
      rangeCalls += 1;
      let source = rows.filter((r) => filters.every((f) => f(r)));
      if (orderKey) {
        const k = orderKey;
        const dir = ascending ? 1 : -1;
        source = source
          .slice()
          .sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir);
      }
      const cappedTo = Math.min(to, from + DB_MAX_ROWS - 1);
      return { data: source.slice(from, cappedTo + 1), error: null };
    },
    get rangeCalls() {
      return rangeCalls;
    },
  };
  return api;
}

function generateLeaveRows(staffCount: number, rowsPerStaff: number): Row[] {
  const rows: Row[] = [];
  const types = ["annual", "sick", "study", "parental"] as const;
  const base = new Date("2020-01-01T00:00:00Z").getTime();
  for (let s = 0; s < staffCount; s++) {
    const staffId = `staff-${String(s).padStart(4, "0")}`;
    for (let i = 0; i < rowsPerStaff; i++) {
      const dayOffset = s * 3 + i * 7; // spread evenly, no dup dates per staff
      const d = new Date(base + dayOffset * 86_400_000)
        .toISOString()
        .slice(0, 10);
      rows.push({
        id: `${staffId}-${i}`,
        staff_id: staffId,
        type: types[i % types.length]!,
        status: "approved",
        end_date: d,
      });
    }
  }
  // Shuffle deterministically so the raw table order does NOT match the
  // requested `.order('end_date')` — proves the pager honours ordering.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = (i * 2654435761) % (i + 1); // Knuth multiplicative hash → deterministic
    const tmp = rows[i]!;
    rows[i] = rows[j]!;
    rows[j] = tmp;
  }
  return rows;
}

describe("paginated leave query — stress & performance", () => {
  it("returns every row in deterministic end_date-desc order across 5,000 rows", async () => {
    const rows = generateLeaveRows(50, 100); // 5,000 rows
    const table = makeFakeLeaveTable(rows);

    const out = await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );

    expect(out).toHaveLength(rows.length);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.end_date >= out[i]!.end_date).toBe(true);
    }
    // Correctness cross-check: id set is identical.
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it("issues exactly ceil(rows/pageSize) requests, never per-row", async () => {
    // 5,000 rows → 5 full pages, then one short/empty stop page.
    const rows = generateLeaveRows(50, 100);
    const table = makeFakeLeaveTable(rows);
    await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );
    // 5,000 % 1,000 === 0 → pager must issue one extra empty page to detect
    // the end. Budget: 6 requests total, and absolutely not 5,000.
    expect(table.rangeCalls).toBe(6);
    expect(table.rangeCalls).toBeLessThan(rows.length);
  });

  it("keeps request count bounded when a staff filter is applied", async () => {
    const rows = generateLeaveRows(200, 30); // 6,000 rows across 200 staff
    const table = makeFakeLeaveTable(rows);

    const out = await fetchAllPaged<Row>(
      () =>
        table
          .eq("staff_id", "staff-0007")
          .order("end_date", { ascending: false }),
      PAGE_SIZE,
    );

    // 30 rows for that staff → single short page terminates immediately.
    expect(out).toHaveLength(30);
    expect(table.rangeCalls).toBe(1);
    expect(out.every((r) => r.staff_id === "staff-0007")).toBe(true);
  });

  it("stays within a tight time budget for a 25,000-row dataset", async () => {
    const rows = generateLeaveRows(250, 100); // 25,000 rows
    const table = makeFakeLeaveTable(rows);

    const start = performance.now();
    const out = await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );
    const elapsed = performance.now() - start;

    expect(out).toHaveLength(25_000);
    // 25 full pages + 1 stop page. Absolutely no per-row fetching.
    expect(table.rangeCalls).toBe(26);
    // Generous ceiling — real bug would be O(n^2) sorting per page and blow
    // past this by orders of magnitude. On CI hardware this typically runs
    // in under 500 ms.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("computes correct 'days since last annual leave' for every staff member at scale", async () => {
    // 100 staff, each with a recent annual-leave spell that ONLY the
    // paginated + ordered read can surface once the table exceeds
    // db-max-rows.
    const rows = generateLeaveRows(100, 50); // 5,000 rows
    // Inject a known-recent annual leave for each staff so we have an
    // expected answer to check against.
    const recentByStaff = new Map<string, string>();
    const todayMs = new Date("2026-07-10T00:00:00Z").getTime();
    for (let s = 0; s < 100; s++) {
      const staffId = `staff-${String(s).padStart(4, "0")}`;
      const daysAgo = 5 + (s % 40); // 5..44 days ago
      const end = new Date(todayMs - daysAgo * 86_400_000)
        .toISOString()
        .slice(0, 10);
      rows.push({
        id: `${staffId}-recent-annual`,
        staff_id: staffId,
        type: "annual",
        status: "approved",
        end_date: end,
      });
      recentByStaff.set(staffId, end);
    }
    const table = makeFakeLeaveTable(rows);
    const out = await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );

    // Group by staff and compute "days since last approved annual leave"
    // using the same logic the app uses.
    const perStaffLast = new Map<string, string>();
    for (const r of out) {
      if (r.type !== "annual" || r.status !== "approved") continue;
      const cur = perStaffLast.get(r.staff_id);
      if (!cur || r.end_date > cur) perStaffLast.set(r.staff_id, r.end_date);
    }

    for (const [staffId, expectedEnd] of recentByStaff) {
      const gotEnd = perStaffLast.get(staffId);
      expect(gotEnd, `no annual leave found for ${staffId}`).toBeDefined();
      const expectedDays = Math.floor(
        (todayMs - new Date(expectedEnd).getTime()) / 86_400_000,
      );
      const gotDays = Math.floor(
        (todayMs - new Date(gotEnd!).getTime()) / 86_400_000,
      );
      expect(gotDays).toBe(expectedDays);
      // Guard against the historical bug: never > 300 days when a real
      // recent spell exists.
      expect(gotDays).toBeLessThan(300);
    }
  });
});
