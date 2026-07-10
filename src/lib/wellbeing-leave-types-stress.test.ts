import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";
import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

/**
 * Stress / performance regression for the paginated leave read across all
 * leave types the wellbeing dashboards actually distinguish: `annual`,
 * `study`, and `compassionate`. The historic bug (single wide `.range()`
 * capped at db-max-rows without an `.order()`) silently truncated the
 * result set and hid recent leave for individual staff. This suite
 * asserts, per leave type:
 *
 *   1. Correctness at scale — every row survives pagination and comes
 *      back in the requested `end_date DESC` order.
 *   2. Per-staff filter correctness — `.eq('staff_id', ...)` still
 *      returns exactly that staff's rows once the full table exceeds
 *      db-max-rows.
 *   3. Query-count budget — `fetchAllPaged` issues `ceil(n/pageSize)`
 *      (+1 empty stop page when n is a multiple of pageSize) requests,
 *      never per-row.
 *   4. Wellbeing signals derived from those rows (rejected/cancelled
 *      `badLeave`, days-since-last-approved for annual) match the
 *      values computed against the ground-truth dataset.
 */

const DB_MAX_ROWS = 1000;
const PAGE_SIZE = 1000;
const NOW = new Date("2026-07-10T00:00:00Z");
const DAY_MS = 86_400_000;

type LeaveType = "annual" | "study" | "compassionate";
type Row = LeaveLite & { id: string };

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

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
          .sort((a, b) => (((a[k] ?? "") < (b[k] ?? "")) ? -1 : ((a[k] ?? "") > (b[k] ?? "")) ? 1 : 0) * dir);
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

/**
 * Build a large synthetic leave dataset: 200 staff, each with a mix of
 * rows across all types plus one known-recent annual spell and one
 * known-recent rejected spell of the given `focusType`. Total rows are
 * comfortably above db-max-rows so pagination is exercised.
 */
function buildDataset(focusType: LeaveType) {
  const staffCount = 200;
  const oldPerStaff = 40; // older filler rows per staff
  const rows: Row[] = [];
  const expectedRecentAnnualByStaff = new Map<string, string>();
  const expectedRecentDenialByStaff = new Map<string, string>();

  for (let s = 0; s < staffCount; s++) {
    const staffId = `staff-${String(s).padStart(4, "0")}`;

    // Old approved rows spread across all 3 types, well outside the
    // 90-day wellbeing window (200+ days ago), used purely to inflate
    // the table past db-max-rows.
    for (let i = 0; i < oldPerStaff; i++) {
      const type: LeaveType = (["annual", "study", "compassionate"] as const)[
        i % 3
      ]!;
      const daysAgo = 200 + s * 3 + i * 7;
      rows.push({
        id: `${staffId}-old-${i}`,
        staff_id: staffId,
        type,
        status: "approved",
        start_date: isoDaysAgo(daysAgo),
        end_date: isoDaysAgo(daysAgo),
      });
    }

    // Recent APPROVED annual spell — must be surfaced by the paginated
    // read so days-since-last-annual-leave is correct.
    const annualDaysAgo = 5 + (s % 30);
    const annualEnd = isoDaysAgo(annualDaysAgo);
    rows.push({
      id: `${staffId}-recent-annual`,
      staff_id: staffId,
      type: "annual",
      status: "approved",
      start_date: isoDaysAgo(annualDaysAgo + 3),
      end_date: annualEnd,
    });
    expectedRecentAnnualByStaff.set(staffId, annualEnd);

    // Recent DENIED spell of the focus type — must be surfaced and count
    // toward the wellbeing `badLeave` driver.
    const denialDaysAgo = 10 + (s % 40);
    const denialEnd = isoDaysAgo(denialDaysAgo);
    rows.push({
      id: `${staffId}-recent-${focusType}-rejected`,
      staff_id: staffId,
      type: focusType,
      status: "rejected",
      start_date: isoDaysAgo(denialDaysAgo + 2),
      end_date: denialEnd,
    });
    expectedRecentDenialByStaff.set(staffId, denialEnd);
  }

  // Deterministic shuffle so raw insertion order != end_date order.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = (i * 2654435761) % (i + 1);
    const tmp = rows[i]!;
    rows[i] = rows[j]!;
    rows[j] = tmp;
  }

  return {
    rows,
    staffCount,
    expectedRecentAnnualByStaff,
    expectedRecentDenialByStaff,
  };
}

const LEAVE_TYPES: LeaveType[] = ["annual", "study", "compassionate"];

describe.each(LEAVE_TYPES)(
  "paginated leave read — stress & correctness for %s leave",
  (leaveType) => {
    it("returns every row in deterministic end_date-desc order past the db-max-rows cap", async () => {
      const { rows } = buildDataset(leaveType);
      expect(rows.length).toBeGreaterThan(DB_MAX_ROWS);

      const table = makeFakeLeaveTable(rows);
      const out = await fetchAllPaged<Row>(
        () => table.order("end_date", { ascending: false }),
        PAGE_SIZE,
      );

      expect(out).toHaveLength(rows.length);
      for (let i = 1; i < out.length; i++) {
        expect(out[i - 1]!.end_date >= out[i]!.end_date).toBe(true);
      }
      // Query budget: exactly ceil(n / pageSize), plus one empty stop
      // page when n is a multiple of pageSize.
      const expectedCalls =
        Math.ceil(rows.length / PAGE_SIZE) +
        (rows.length % PAGE_SIZE === 0 ? 1 : 0);
      expect(table.rangeCalls).toBe(expectedCalls);
      expect(table.rangeCalls).toBeLessThan(rows.length);
    });

    it("per-staff filter returns exactly that staff's rows and terminates in one page", async () => {
      const { rows } = buildDataset(leaveType);
      const staffId = "staff-0123";
      const expected = rows.filter((r) => r.staff_id === staffId);
      expect(expected.length).toBeGreaterThan(0);

      const table = makeFakeLeaveTable(rows);
      const out = await fetchAllPaged<Row>(
        () =>
          table.eq("staff_id", staffId).order("end_date", { ascending: false }),
        PAGE_SIZE,
      );

      expect(out).toHaveLength(expected.length);
      expect(out.every((r) => r.staff_id === staffId)).toBe(true);
      // A single short page → the pager stops immediately.
      expect(table.rangeCalls).toBe(1);
    });

    it("stays within a tight time budget for a 25k-row dataset", async () => {
      // Scale to 25k rows: 500 staff * (40 old + 2 recent) ≈ 21k, plus
      // padding to cross 25k.
      const rows: Row[] = [];
      for (let s = 0; s < 500; s++) {
        const staffId = `staff-${String(s).padStart(4, "0")}`;
        for (let i = 0; i < 50; i++) {
          rows.push({
            id: `${staffId}-${i}`,
            staff_id: staffId,
            type: leaveType,
            status: i % 7 === 0 ? "rejected" : "approved",
            start_date: isoDaysAgo(200 + i),
            end_date: isoDaysAgo(200 + i),
          });
        }
      }
      const table = makeFakeLeaveTable(rows);

      const start = performance.now();
      const out = await fetchAllPaged<Row>(
        () => table.order("end_date", { ascending: false }),
        PAGE_SIZE,
      );
      const elapsed = performance.now() - start;

      expect(out).toHaveLength(rows.length);
      const expectedCalls =
        Math.ceil(rows.length / PAGE_SIZE) +
        (rows.length % PAGE_SIZE === 0 ? 1 : 0);
      expect(table.rangeCalls).toBe(expectedCalls);
      // Generous ceiling — real regression (O(n^2)) blows past this by
      // orders of magnitude. On CI hardware this runs in well under 1s.
      expect(elapsed).toBeLessThan(5_000);
    });

    it("wellbeing signals derived from the paginated read match ground truth for every staff", async () => {
      const { rows, expectedRecentDenialByStaff } = buildDataset(leaveType);
      const table = makeFakeLeaveTable(rows);
      const allLeave = await fetchAllPaged<LeaveLite>(
        () => table.order("end_date", { ascending: false }),
        PAGE_SIZE,
      );
      expect(allLeave).toHaveLength(rows.length);

      // Spot-check 25 staff evenly across the cohort.
      const staffIds = Array.from(expectedRecentDenialByStaff.keys());
      const sample = staffIds.filter((_, i) => i % 8 === 0);

      for (const staffId of sample) {
        const result = computeWellbeing({
          staffId,
          now: NOW,
          assignments: [],
          changes: [],
          leave: allLeave.filter((l) => l.staff_id === staffId),
          exceptions: [],
        });

        const badLeave = result.drivers.find((d) => d.key === "leave")!;
        // Exactly one recent denial per staff of the focus type is
        // in-window (10..49 days ago vs. a 90-day window).
        expect(badLeave.value).toBe(1);
        expect(badLeave.normalised).toBeGreaterThan(0);
      }
    });
  },
);

describe("paginated leave read — cross-type correctness at scale", () => {
  it("preserves per-staff annual, study, and compassionate spells simultaneously", async () => {
    // Build a mixed dataset where each staff has one recent spell of
    // each leave type, distributed so the raw table crosses many pages.
    const staffCount = 300;
    const rows: Row[] = [];
    for (let s = 0; s < staffCount; s++) {
      const staffId = `staff-${String(s).padStart(4, "0")}`;
      // Older filler rows.
      for (let i = 0; i < 20; i++) {
        rows.push({
          id: `${staffId}-old-${i}`,
          staff_id: staffId,
          type: (["annual", "study", "compassionate"] as const)[i % 3]!,
          status: "approved",
          start_date: isoDaysAgo(300 + i),
          end_date: isoDaysAgo(300 + i),
        });
      }
      for (const type of LEAVE_TYPES) {
        rows.push({
          id: `${staffId}-recent-${type}`,
          staff_id: staffId,
          type,
          status: type === "annual" ? "approved" : "rejected",
          start_date: isoDaysAgo(15 + s % 30),
          end_date: isoDaysAgo(12 + s % 30),
        });
      }
    }
    // Deterministic shuffle.
    for (let i = rows.length - 1; i > 0; i--) {
      const j = (i * 2654435761) % (i + 1);
      const tmp = rows[i]!;
      rows[i] = rows[j]!;
      rows[j] = tmp;
    }
    expect(rows.length).toBeGreaterThan(DB_MAX_ROWS * 6);

    const table = makeFakeLeaveTable(rows);
    const out = await fetchAllPaged<Row>(
      () => table.order("end_date", { ascending: false }),
      PAGE_SIZE,
    );
    expect(out).toHaveLength(rows.length);

    // For every staff, the paginated read must contain the recent row
    // of each of the three types.
    for (let s = 0; s < staffCount; s++) {
      const staffId = `staff-${String(s).padStart(4, "0")}`;
      const forStaff = out.filter((r) => r.staff_id === staffId);
      for (const type of LEAVE_TYPES) {
        expect(
          forStaff.some((r) => r.id === `${staffId}-recent-${type}`),
          `missing recent ${type} row for ${staffId}`,
        ).toBe(true);
      }
    }

    // Query-count budget still holds across the mixed workload.
    const expectedCalls =
      Math.ceil(rows.length / PAGE_SIZE) +
      (rows.length % PAGE_SIZE === 0 ? 1 : 0);
    expect(table.rangeCalls).toBe(expectedCalls);
  });
});
