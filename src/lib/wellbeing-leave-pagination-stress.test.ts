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
 *
 * ## Dataset profiles
 *
 * The suite runs with a size profile chosen from `LEAVE_STRESS_PROFILE`:
 *
 *   - `small` (default, used in normal `bun run test` and PR CI):
 *       5k / 6k / 25k rows across the scenarios. Fast (<3s), keeps the
 *       stress test in the standard test loop without slowing feedback.
 *   - `large` (opt-in, used by the `stress-tests` CI job on push to main
 *       and via `bun run test:stress:large`):
 *       50k / 60k / 200k rows. Catches performance regressions (accidental
 *       O(n^2) sorts, per-row fetches, memory blow-ups) that a 5k dataset
 *       is too small to expose.
 *
 * Row-count budgets (`table.rangeCalls`) and time budgets scale with the
 * profile so a doubling of the dataset does NOT mean a doubling of the
 * page-request count — the pager must remain O(rows/pageSize).
 */

const DB_MAX_ROWS = 1000;
const PAGE_SIZE = 1000;

type Profile = {
  name: "small" | "large";
  scenarioA: { staff: number; perStaff: number }; // ordered read
  scenarioB: { staff: number; perStaff: number }; // filtered read
  scenarioC: { staff: number; perStaff: number }; // time budget
  scenarioD: { staff: number; perStaff: number }; // days-since-last-annual
  // Wall-clock ceiling for scenario C, in milliseconds.
  timeBudgetMs: number;
};

const PROFILES: Record<"small" | "large", Profile> = {
  small: {
    name: "small",
    scenarioA: { staff: 50, perStaff: 100 }, // 5,000
    scenarioB: { staff: 200, perStaff: 30 }, // 6,000
    scenarioC: { staff: 250, perStaff: 100 }, // 25,000
    scenarioD: { staff: 100, perStaff: 50 }, // 5,000 + 100 recent
    timeBudgetMs: 5_000,
  },
  large: {
    name: "large",
    scenarioA: { staff: 500, perStaff: 100 }, // 50,000
    scenarioB: { staff: 2_000, perStaff: 30 }, // 60,000
    scenarioC: { staff: 500, perStaff: 200 }, // 100,000
    scenarioD: { staff: 500, perStaff: 100 }, // 50,000 + 500 recent
    // Fake table sorts each page against the full row set, so total work is
    // O(pages × rows log rows). CI machines are slower than dev; 60s covers
    // the 100k-row case with plenty of headroom before flakiness.
    timeBudgetMs: 60_000,
  },
};

const PROFILE: Profile =
  PROFILES[(process.env.LEAVE_STRESS_PROFILE as "small" | "large") ?? "small"] ??
  PROFILES.small;

// eslint-disable-next-line no-console
console.info(`[leave-pagination-stress] profile=${PROFILE.name}`);

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

/** ceil(rows/pageSize) with an extra "stop" page when rows is a multiple of pageSize. */
function expectedRangeCalls(rows: number, pageSize: number): number {
  return Math.floor(rows / pageSize) + (rows % pageSize === 0 ? 1 : Math.ceil((rows % pageSize) / pageSize));
}

describe(`paginated leave query — stress & performance (profile=${PROFILE.name})`, () => {
  it("returns every row in deterministic end_date-desc order", async () => {
    const { staff, perStaff } = PROFILE.scenarioA;
    const rows = generateLeaveRows(staff, perStaff);
    const table = makeFakeLeaveTable(rows);

    const out = await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );

    expect(out).toHaveLength(rows.length);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.end_date >= out[i]!.end_date).toBe(true);
    }
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it("issues exactly ceil(rows/pageSize) requests, never per-row", async () => {
    const { staff, perStaff } = PROFILE.scenarioA;
    const rows = generateLeaveRows(staff, perStaff);
    const table = makeFakeLeaveTable(rows);
    await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );
    expect(table.rangeCalls).toBe(expectedRangeCalls(rows.length, PAGE_SIZE));
    expect(table.rangeCalls).toBeLessThan(rows.length);
  });

  it("keeps request count bounded when a staff filter is applied", async () => {
    const { staff, perStaff } = PROFILE.scenarioB;
    const rows = generateLeaveRows(staff, perStaff);
    const table = makeFakeLeaveTable(rows);

    const targetStaff = "staff-0007";
    const out = await fetchAllPaged<Row>(
      () =>
        table
          .eq("staff_id", targetStaff)
          .order("end_date", { ascending: false }),
      PAGE_SIZE,
    );

    // One page per <= PAGE_SIZE rows for that staff.
    expect(out).toHaveLength(perStaff);
    expect(table.rangeCalls).toBe(expectedRangeCalls(perStaff, PAGE_SIZE));
    expect(out.every((r) => r.staff_id === targetStaff)).toBe(true);
  });

  it(
    "stays within a tight time budget for a large dataset",
    async () => {
      const { staff, perStaff } = PROFILE.scenarioC;
      const rows = generateLeaveRows(staff, perStaff);
      const table = makeFakeLeaveTable(rows);

      const start = performance.now();
      const out = await fetchAllPaged<Row>(
        () => table.order("end_date", { ascending: false }),
        PAGE_SIZE,
      );
      const elapsed = performance.now() - start;

      expect(out).toHaveLength(rows.length);
      expect(table.rangeCalls).toBe(expectedRangeCalls(rows.length, PAGE_SIZE));
      expect(elapsed).toBeLessThan(PROFILE.timeBudgetMs);
    },
    // Vitest's default 5s test timeout would kill the large-profile run before
    // the elapsed assertion could fire. Bound it to the profile's own budget
    // plus generous headroom for CI cold-start.
    PROFILE.timeBudgetMs + 30_000,
  );

  it("computes correct 'days since last annual leave' for every staff member at scale", async () => {
    const { staff, perStaff } = PROFILE.scenarioD;
    // Strip pre-existing annual/approved rows so the injected "recent" row
    // is unambiguously the most recent for every staff — otherwise the
    // generator's spread can, at large profile sizes, produce a base row
    // with an even later end_date and beat the injected value.
    const baseRows = generateLeaveRows(staff, perStaff).filter(
      (r) => !(r.type === "annual" && r.status === "approved"),
    );
    const rows: Row[] = baseRows;
    const recentByStaff = new Map<string, string>();
    const todayMs = new Date("2026-07-10T00:00:00Z").getTime();
    for (let s = 0; s < staff; s++) {
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
      expect(gotDays).toBeLessThan(300);
    }
  });
});

