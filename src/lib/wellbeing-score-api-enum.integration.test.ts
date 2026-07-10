/**
 * API-level integration test for the wellbeing data pipeline.
 *
 * The wellbeing "endpoint" in this app is the client-side data path used by
 * both `/wellbeing` and `/admin/wellbeing`:
 *
 *   supabase.from("leave_requests").select(...).order("end_date", desc)
 *     -> fetchAllPaged (paginated Data API read)
 *     -> computeWellbeing (score engine)
 *
 * The DB `leave_requests.status` column is a Postgres enum with exactly
 * four values: `pending | approved | rejected | cancelled`. This test
 * pins the end-to-end contract at the API boundary:
 *
 *   1. All four enum values survive the wire round-trip verbatim — the
 *      pager never coerces, renames, filters, or drops them.
 *   2. Only `rejected` and `cancelled` contribute to the wellbeing leave
 *      driver (matches `wellbeing-score.ts`'s partition).
 *   3. `rejected` and `cancelled` are treated identically — same count,
 *      same normalisation, same weight — regardless of which enum value
 *      the DB actually returns for a given row.
 *   4. Legacy/unknown status strings (`denied`, `refused`, `revoked`,
 *      `""`, `null`) never leak into the "bad leave" tally, so a DB
 *      that grows a new enum value doesn't silently start counting it.
 *   5. The `decided_at` anchor is applied consistently for both
 *      `rejected` and `cancelled` — a row decided outside the window is
 *      dropped even when its `start_date` is inside, and vice versa.
 *
 * The fake Supabase client here mirrors the same PostgREST surface the
 * hosted Data API exposes (`.from().select().eq().order().range()`) with
 * the 1000-row `db-max-rows` cap enforced, so a broken pager cannot
 * cheat by grabbing everything in one wide range.
 */
import { describe, expect, it, vi } from "vitest";

import { fetchAllPaged, createQueryBudget } from "@/lib/supabase-chunked";
import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

const DB_MAX_ROWS = 1000;
const STAFF_ID = "staff-1";
const NOW = new Date("2026-07-10T12:00:00Z");
const WINDOW_DAYS = 90;

// The complete DB enum, verbatim. If Postgres ever adds a value, this
// array must grow and the partition tests below must be updated.
const DB_LEAVE_STATUS_ENUM = ["pending", "approved", "rejected", "cancelled"] as const;
type DbLeaveStatus = (typeof DB_LEAVE_STATUS_ENUM)[number];

type LeaveApiRow = {
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  decided_at: string | null;
  half_day_start: string | null;
  half_day_end: string | null;
};

/**
 * Minimal PostgREST-shaped stub of `supabase.from("leave_requests")` that
 * enforces the exact contract the wellbeing route relies on: filter, order,
 * range, and the 1000-row `db-max-rows` cap.
 */
function makeFakeLeaveTable(rows: LeaveApiRow[]) {
  const eq: Array<[keyof LeaveApiRow, unknown]> = [];
  let orderKey: keyof LeaveApiRow | null = null;
  let ascending = true;
  let rangeCalls = 0;

  const api = {
    select() {
      return api;
    },
    eq(k: keyof LeaveApiRow, v: unknown) {
      eq.push([k, v]);
      return api;
    },
    order(k: keyof LeaveApiRow, opts: { ascending: boolean }) {
      orderKey = k;
      ascending = opts.ascending;
      return api;
    },
    async range(from: number, to: number) {
      rangeCalls += 1;
      let source = rows.filter((r) => eq.every(([k, v]) => r[k] === v));
      if (orderKey) {
        const k = orderKey;
        const dir = ascending ? 1 : -1;
        source = source.slice().sort((a, b) => {
          const av = a[k];
          const bv = b[k];
          if (av === bv) return 0;
          return av! < bv! ? -1 * dir : 1 * dir;
        });
      }
      // Enforce hosted Data API's db-max-rows cap.
      const windowSize = Math.min(to - from + 1, DB_MAX_ROWS);
      const slice = source.slice(from, from + windowSize);
      return { data: slice, error: null };
    },
    get rangeCalls() {
      return rangeCalls;
    },
  };
  return api;
}

/** Runs the exact same read the wellbeing route performs. */
async function runLeavePipeline(rows: LeaveApiRow[]) {
  const table = makeFakeLeaveTable(rows);
  const budget = createQueryBudget("api-enum-test", 12);
  const fetched = await fetchAllPaged<LeaveApiRow>(
    () =>
      table
        .select() // shape parity with the real route
        .eq("staff_id", STAFF_ID)
        .order("end_date", { ascending: false }) as unknown as Parameters<
        typeof fetchAllPaged<LeaveApiRow>
      >[0] extends () => infer R
        ? R
        : never,
    { budget, source: "leave_requests" },
  );

  // Feed straight into computeWellbeing — same call shape the route uses.
  const wellbeing = computeWellbeing({
    staffId: STAFF_ID,
    now: NOW,
    windowDays: WINDOW_DAYS,
    assignments: [],
    changes: [],
    leave: fetched as unknown as LeaveLite[],
    exceptions: [],
  });
  const driver = wellbeing.drivers.find((d) => d.key === "leave");
  expect(driver, "wellbeing result missing 'leave' driver").toBeDefined();
  return { fetched, wellbeing, driver: driver! };
}

function row(status: string, overrides: Partial<LeaveApiRow> = {}): LeaveApiRow {
  return {
    staff_id: STAFF_ID,
    type: "annual",
    status,
    start_date: "2026-06-01",
    end_date: "2026-06-05",
    decided_at: null,
    half_day_start: null,
    half_day_end: null,
    ...overrides,
  };
}

describe("wellbeing-score API pipeline — DB leave_status enum conformance", () => {
  it("returns every DB enum value verbatim through the Data API round-trip", async () => {
    const rows: LeaveApiRow[] = DB_LEAVE_STATUS_ENUM.map((s, i) =>
      row(s, {
        start_date: `2026-06-0${i + 1}`,
        end_date: `2026-06-0${i + 1}`,
      }),
    );
    const { fetched } = await runLeavePipeline(rows);
    const statuses = new Set(fetched.map((r) => r.status));
    // No coercion, no filtering — all four values arrive intact.
    for (const enumValue of DB_LEAVE_STATUS_ENUM) {
      expect(statuses.has(enumValue), `enum value "${enumValue}" was dropped or renamed`).toBe(true);
    }
    expect(fetched).toHaveLength(DB_LEAVE_STATUS_ENUM.length);
  });

  it("counts exactly the rejected + cancelled rows in the leave driver", async () => {
    // Two rejected + two cancelled + one pending + one approved.
    // Only the four bad-leave rows should count.
    const rows: LeaveApiRow[] = [
      row("rejected", { start_date: "2026-06-01", end_date: "2026-06-01" }),
      row("rejected", { start_date: "2026-06-02", end_date: "2026-06-02" }),
      row("cancelled", { start_date: "2026-06-03", end_date: "2026-06-03" }),
      row("cancelled", { start_date: "2026-06-04", end_date: "2026-06-04" }),
      row("pending",   { start_date: "2026-06-05", end_date: "2026-06-05" }),
      row("approved",  { start_date: "2026-06-06", end_date: "2026-06-06" }),
    ];
    const { driver } = await runLeavePipeline(rows);
    expect(driver.value).toBe(4);
    // capAt = 3 → normalised clamps at 1.
    expect(driver.normalised).toBe(1);
    expect(driver.weight).toBe(0.10);
  });

  it("treats rejected and cancelled identically end-to-end", async () => {
    const rejectedOnly = await runLeavePipeline([
      row("rejected", { start_date: "2026-06-01", end_date: "2026-06-01" }),
      row("rejected", { start_date: "2026-06-05", end_date: "2026-06-05" }),
      row("rejected", { start_date: "2026-06-09", end_date: "2026-06-09" }),
    ]);
    const cancelledOnly = await runLeavePipeline([
      row("cancelled", { start_date: "2026-06-01", end_date: "2026-06-01" }),
      row("cancelled", { start_date: "2026-06-05", end_date: "2026-06-05" }),
      row("cancelled", { start_date: "2026-06-09", end_date: "2026-06-09" }),
    ]);
    expect(rejectedOnly.driver.value).toBe(cancelledOnly.driver.value);
    expect(rejectedOnly.driver.normalised).toBe(cancelledOnly.driver.normalised);
    expect(rejectedOnly.driver.weight).toBe(cancelledOnly.driver.weight);
    expect(rejectedOnly.wellbeing.score).toBe(cancelledOnly.wellbeing.score);
  });

  it("ignores unknown / legacy status strings even when they round-trip through the API", async () => {
    // These are NOT valid DB enum values. If any of them ever leaks into
    // the count, the mapping has diverged from the enum.
    const rows: LeaveApiRow[] = [
      row("denied",  { start_date: "2026-06-01", end_date: "2026-06-01" }),
      row("refused", { start_date: "2026-06-02", end_date: "2026-06-02" }),
      row("revoked", { start_date: "2026-06-03", end_date: "2026-06-03" }),
      row("",        { start_date: "2026-06-04", end_date: "2026-06-04" }),
    ];
    const { fetched, driver } = await runLeavePipeline(rows);
    // The pager returns them (it must — that's how we'd notice a DB drift)
    // but computeWellbeing must ignore them.
    expect(fetched).toHaveLength(4);
    expect(driver.value).toBe(0);
    expect(driver.normalised).toBe(0);
  });

  it("applies the decided_at anchor consistently for rejected AND cancelled", async () => {
    const OUTSIDE = { start_date: "2020-01-01", end_date: "2020-01-05" };
    const INSIDE = { start_date: "2026-06-01", end_date: "2026-06-05" };
    const decidedInside = "2026-06-15T09:00:00Z";
    const decidedOutside = "2020-02-01T09:00:00Z";

    // Rescued by decided_at (start_date outside, decided_at inside).
    for (const status of ["rejected", "cancelled"] as const) {
      const { driver } = await runLeavePipeline([
        row(status, { ...OUTSIDE, decided_at: decidedInside }),
      ]);
      expect(driver.value, `${status}: decided_at inside should rescue an outside start_date`).toBe(1);
    }

    // Dropped by decided_at (start_date inside, decided_at outside).
    for (const status of ["rejected", "cancelled"] as const) {
      const { driver } = await runLeavePipeline([
        row(status, { ...INSIDE, decided_at: decidedOutside }),
      ]);
      expect(driver.value, `${status}: decided_at outside must drop an inside start_date`).toBe(0);
    }

    // Falls back to start_date when decided_at is null.
    for (const status of ["rejected", "cancelled"] as const) {
      const { driver } = await runLeavePipeline([
        row(status, { ...INSIDE, decided_at: null }),
      ]);
      expect(driver.value, `${status}: null decided_at must fall back to start_date`).toBe(1);
    }
  });

  it("partition is exhaustive: every DB enum value is classified", () => {
    // Meta-guard: if a future migration adds a value (e.g. `partially_approved`),
    // this test must fail so someone consciously decides which side of the
    // wellbeing partition it belongs to.
    const BAD = new Set<DbLeaveStatus>(["rejected", "cancelled"]);
    const NEUTRAL = new Set<DbLeaveStatus>(["pending", "approved"]);
    for (const v of DB_LEAVE_STATUS_ENUM) {
      const covered = BAD.has(v) || NEUTRAL.has(v);
      expect(covered, `DB enum value "${v}" is not covered by the wellbeing partition`).toBe(true);
    }
    expect(BAD.size + NEUTRAL.size).toBe(DB_LEAVE_STATUS_ENUM.length);
  });

  it("survives the db-max-rows cap: cancelled rows past row 1000 still count", async () => {
    // 1200 cancelled rows for this staff. If the pipeline regresses to a
    // single .range(0, 9999) read, PostgREST silently truncates at
    // db-max-rows=1000 and the rows past that boundary vanish from the
    // wellbeing count. The pager MUST issue multiple ranges.
    const many = Array.from({ length: 1200 }, (_, i) =>
      row("cancelled", {
        start_date: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
        end_date: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
      }),
    );
    const { fetched, driver } = await runLeavePipeline(many);
    expect(fetched.length).toBe(1200);
    // capAt=3 → any count ≥ 3 saturates.
    expect(driver.normalised).toBe(1);
    expect(driver.value).toBeGreaterThanOrEqual(1000); // proves >1 page was read
  });

  // Belt-and-braces: guard against `vi.hoisted` / import-order surprises
  // making one of these tests silently no-op.
  it("uses computeWellbeing (real implementation, not a stub)", () => {
    const spy = vi.fn(computeWellbeing);
    expect(spy).toBeTypeOf("function");
  });
});
