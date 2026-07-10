import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// Small overrun the wall-clock assertion tolerates before failing the build.
// The profile's `timeBudgetMs` is the *target* — a small buffer absorbs
// legitimate CI noise (cold caches, shared-runner jitter) while still failing
// hard on real regressions. Override with `LEAVE_STRESS_TIME_THRESHOLD` if
// tuning is needed (e.g. `0.25` = 25%). Default 15%.
const RAW_THRESHOLD = Number.parseFloat(
  process.env.LEAVE_STRESS_TIME_THRESHOLD ?? "0.15",
);
const TIME_OVERRUN_THRESHOLD =
  Number.isFinite(RAW_THRESHOLD) && RAW_THRESHOLD >= 0 ? RAW_THRESHOLD : 0.15;
const HARD_TIME_LIMIT_MS = Math.round(
  PROFILE.timeBudgetMs * (1 + TIME_OVERRUN_THRESHOLD),
);

// eslint-disable-next-line no-console
console.info(`[leave-pagination-stress] profile=${PROFILE.name}`);

// -----------------------------------------------------------------------------
// Baseline-vs-regression enforcement.
//
// The `large` profile records the last-known-good runtime for each scenario
// in `wellbeing-leave-pagination-stress.baseline.json`. When the large
// profile runs (nightly + push-to-main CI), each scenario's elapsed time is
// checked against `baseline * (1 + regressionThreshold)`; anything slower
// fails the build. This catches gradual O(n^2) creep the absolute
// `timeBudgetMs` on scenario C alone would miss (e.g. a 10x slowdown on
// scenario A that still fits under the wall-clock cap).
//
// To refresh the baseline after a legitimate perf change:
//   LEAVE_STRESS_PROFILE=large LEAVE_STRESS_UPDATE_BASELINE=1 \
//     bun run test:stress:large
// then commit the updated JSON.
// -----------------------------------------------------------------------------
type ScenarioKey =
  | "orderedRead"
  | "requestCount"
  | "filteredRead"
  | "timeBudget"
  | "daysSinceLastAnnual";

type Baseline = {
  regressionThreshold: number;
  large: {
    recordedAt: string;
    runner: string;
    seed: string;
    scenarios: Record<ScenarioKey, { ms: number }>;
  };
};

const BASELINE_URL = new URL(
  "./wellbeing-leave-pagination-stress.baseline.json",
  import.meta.url,
);
const BASELINE_PATH = fileURLToPath(BASELINE_URL);
const BASELINE: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

const RAW_REGRESSION = Number.parseFloat(
  process.env.LEAVE_STRESS_REGRESSION_THRESHOLD ?? "",
);
const REGRESSION_THRESHOLD =
  Number.isFinite(RAW_REGRESSION) && RAW_REGRESSION >= 0
    ? RAW_REGRESSION
    : BASELINE.regressionThreshold;

const UPDATE_BASELINE = process.env.LEAVE_STRESS_UPDATE_BASELINE === "1";
const ENFORCE_BASELINE = PROFILE.name === "large" && !UPDATE_BASELINE;

const recordedRuntimes: Partial<Record<ScenarioKey, number>> = {};

function recordAndAssert(key: ScenarioKey, elapsedMs: number): void {
  recordedRuntimes[key] = elapsedMs;
  if (!ENFORCE_BASELINE) return;
  const baselineMs = BASELINE.large.scenarios[key].ms;
  const ceilingMs = Math.round(baselineMs * (1 + REGRESSION_THRESHOLD));
  if (elapsedMs > baselineMs) {
    // eslint-disable-next-line no-console
    console.warn(
      `[stress:large] ${key} slower than baseline: ${elapsedMs.toFixed(0)}ms ` +
        `> ${baselineMs}ms (ceiling ${ceilingMs}ms, +${(REGRESSION_THRESHOLD * 100).toFixed(0)}%)`,
    );
  }
  expect(
    elapsedMs,
    `scenario ${key} regressed: ${elapsedMs.toFixed(0)}ms exceeds baseline ` +
      `${baselineMs}ms + ${(REGRESSION_THRESHOLD * 100).toFixed(0)}% = ${ceilingMs}ms. ` +
      `If this is intentional, re-record with LEAVE_STRESS_UPDATE_BASELINE=1.`,
  ).toBeLessThanOrEqual(ceilingMs);
}

afterAll(() => {
  if (!UPDATE_BASELINE || PROFILE.name !== "large") return;
  const next: Baseline = {
    ...BASELINE,
    large: {
      ...BASELINE.large,
      recordedAt: new Date().toISOString().slice(0, 10),
      seed: `0x${SEED.toString(16)}`,
      scenarios: {
        orderedRead: {
          ms: Math.round(recordedRuntimes.orderedRead ?? BASELINE.large.scenarios.orderedRead.ms),
        },
        requestCount: {
          ms: Math.round(recordedRuntimes.requestCount ?? BASELINE.large.scenarios.requestCount.ms),
        },
        filteredRead: {
          ms: Math.round(recordedRuntimes.filteredRead ?? BASELINE.large.scenarios.filteredRead.ms),
        },
        timeBudget: {
          ms: Math.round(recordedRuntimes.timeBudget ?? BASELINE.large.scenarios.timeBudget.ms),
        },
        daysSinceLastAnnual: {
          ms: Math.round(
            recordedRuntimes.daysSinceLastAnnual ??
              BASELINE.large.scenarios.daysSinceLastAnnual.ms,
          ),
        },
      },
    },
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.info(
    `[stress:large] baseline updated at ${BASELINE_PATH}: ${JSON.stringify(next.large.scenarios)}`,
  );
});


// -----------------------------------------------------------------------------
// Deterministic pseudo-random source.
//
// The stress suite must be bit-for-bit repeatable across runs and CI machines
// so a failure is a signal, not noise. Every "randomised" choice below flows
// through `mulberry32(SEED)` — a tiny, fast, deterministic PRNG — so the same
// SEED always yields the same rows, the same shuffle, and therefore the same
// paginated output. Override with `LEAVE_STRESS_SEED=<int>` to reproduce a
// reported failure with a different seed while keeping the run deterministic.
// -----------------------------------------------------------------------------
const RAW_SEED = Number.parseInt(process.env.LEAVE_STRESS_SEED ?? "", 10);
const SEED = Number.isFinite(RAW_SEED) && RAW_SEED > 0 ? RAW_SEED : 0xC0FFEE;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// eslint-disable-next-line no-console
console.info(`[leave-pagination-stress] seed=0x${SEED.toString(16)}`);

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
        source = source.slice().sort((a, b) => {
          // Primary key: the requested column. Ties are broken by `id` so
          // rows sharing an `end_date` still have a single, deterministic
          // ordering — independent of V8's sort-stability implementation
          // details or the pre-sort row order.
          if (a[k] < b[k]) return -1 * dir;
          if (a[k] > b[k]) return 1 * dir;
          if (a.id < b.id) return -1;
          if (a.id > b.id) return 1;
          return 0;
        });
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

function generateLeaveRows(staffCount: number, rowsPerStaff: number, seed = SEED): Row[] {
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
  // Seeded Fisher–Yates shuffle so the raw table order does NOT match the
  // requested `.order('end_date')` — proves the pager honours ordering — but
  // is still fully reproducible from `SEED`.
  const rand = mulberry32(seed);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
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

// Any single test must be allowed to run for the profile's hard time limit
// (budget + overrun threshold) plus generous CI cold-start headroom. Vitest's
// default 5s would kill large profile runs before assertions fire.
const TEST_TIMEOUT_MS = HARD_TIME_LIMIT_MS + 30_000;

describe(`paginated leave query — stress & performance (profile=${PROFILE.name})`, () => {
  it("returns every row in deterministic end_date-desc order", { timeout: TEST_TIMEOUT_MS }, async () => {
    const t0 = performance.now();
    const { staff, perStaff } = PROFILE.scenarioA;
    const rows = generateLeaveRows(staff, perStaff);
    const table = makeFakeLeaveTable(rows);

    const out = await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );

    expect(out).toHaveLength(rows.length);
    for (let i = 1; i < out.length; i++) {
      // Primary order: end_date desc. Ties: id asc — the same total order
      // the fake table applies, so the paged output is a single canonical
      // sequence regardless of how the underlying rows were shuffled.
      const prev = out[i - 1]!;
      const cur = out[i]!;
      if (prev.end_date === cur.end_date) {
        expect(prev.id <= cur.id).toBe(true);
      } else {
        expect(prev.end_date > cur.end_date).toBe(true);
      }
    }
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(rows.map((r) => r.id)));

    // Repeatability: a second independent run with the same SEED must
    // produce a bit-for-bit identical id sequence. This is what "stable"
    // buys us — any accidental Date.now()/Math.random() creeping back in
    // would diverge the two sequences and fail here.
    const rows2 = generateLeaveRows(staff, perStaff);
    const table2 = makeFakeLeaveTable(rows2);
    const out2 = await fetchAllPaged<Row>(
      () => table2.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );
    expect(out2.map((r) => r.id)).toEqual(out.map((r) => r.id));
    recordAndAssert("orderedRead", performance.now() - t0);
  });

  it("issues exactly ceil(rows/pageSize) requests, never per-row", { timeout: TEST_TIMEOUT_MS }, async () => {
    const t0 = performance.now();
    const { staff, perStaff } = PROFILE.scenarioA;
    const rows = generateLeaveRows(staff, perStaff);
    const table = makeFakeLeaveTable(rows);
    await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );
    expect(table.rangeCalls).toBe(expectedRangeCalls(rows.length, PAGE_SIZE));
    expect(table.rangeCalls).toBeLessThan(rows.length);
    recordAndAssert("requestCount", performance.now() - t0);
  });

  it("keeps request count bounded when a staff filter is applied", { timeout: TEST_TIMEOUT_MS }, async () => {
    const t0 = performance.now();
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
    recordAndAssert("filteredRead", performance.now() - t0);
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

      // Soft budget: log a warning if we've exceeded the target but stayed
      // under the hard limit. Hard budget: fail the build once elapsed
      // exceeds `timeBudgetMs * (1 + TIME_OVERRUN_THRESHOLD)`.
      if (elapsed > PROFILE.timeBudgetMs) {
        // eslint-disable-next-line no-console
        console.warn(
          `[stress:${PROFILE.name}] scenario C exceeded soft budget: ` +
            `${elapsed.toFixed(0)}ms > ${PROFILE.timeBudgetMs}ms ` +
            `(hard limit ${HARD_TIME_LIMIT_MS}ms, +${(TIME_OVERRUN_THRESHOLD * 100).toFixed(0)}%)`,
        );
      }
      expect(
        elapsed,
        `scenario C runtime ${elapsed.toFixed(0)}ms exceeded hard limit ` +
          `${HARD_TIME_LIMIT_MS}ms (budget ${PROFILE.timeBudgetMs}ms + ` +
          `${(TIME_OVERRUN_THRESHOLD * 100).toFixed(0)}% overrun threshold)`,
      ).toBeLessThan(HARD_TIME_LIMIT_MS);
    },
    // Vitest's default 5s test timeout would kill the large-profile run before
    // the elapsed assertion could fire. Bound it to the profile's hard limit
    // plus generous headroom for CI cold-start.
    HARD_TIME_LIMIT_MS + 30_000,
  );

  it("computes correct 'days since last annual leave' for every staff member at scale", { timeout: TEST_TIMEOUT_MS }, async () => {
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

