import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";
import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

/**
 * Regression: study and compassionate leave were only exercised indirectly
 * by the annual-leave regression suite. `computeWellbeing`'s `badLeave`
 * driver counts denied/cancelled leave of ANY type — so a denied study
 * or compassionate spell should degrade the score just like a denied
 * annual spell. Approved study/compassionate leave, by contrast, must
 * NOT count toward `badLeave` (it isn't a wellbeing harm signal).
 *
 * This suite locks in that behaviour end-to-end against the paginated +
 * ordered read path used by the wellbeing dashboards, so a future change
 * that reintroduces the pre-fix single-wide-`.range()` read (silently
 * capped at db-max-rows) can't drop the recent study/compassionate rows
 * and leave the score looking artificially healthy.
 */

const DB_MAX_ROWS = 1000;
const PAGE_SIZE = 1000;
const NOW = new Date("2026-07-10T00:00:00Z");

type Row = LeaveLite & { id: string };

function makeFakeLeaveTable(rows: Row[]) {
  let orderKey: keyof Row | null = null;
  let ascending = true;
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
  };
  return api;
}

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function padRows(
  count: number,
  staffId: string,
  startId: number,
  daysAgoStart: number,
): Row[] {
  // Padding rows well outside the wellbeing window so they never influence
  // the score directly, but do force the underlying fetch to cross the
  // 1000-row PostgREST cap.
  return Array.from({ length: count }, (_, i) => ({
    id: `pad-${startId + i}`,
    staff_id: staffId,
    type: "annual",
    status: "approved",
    start_date: isoDaysAgo(daysAgoStart + i),
    end_date: isoDaysAgo(daysAgoStart + i),
  }));
}

async function fetchLeaveForStaff(rows: Row[], staffId: string): Promise<LeaveLite[]> {
  const table = makeFakeLeaveTable(rows);
  return await fetchAllPaged<LeaveLite>(
    () => table.eq("staff_id", staffId).order("end_date", { ascending: false }),
    PAGE_SIZE,
  );
}

describe("wellbeing score — study & compassionate leave", () => {
  it("denied study leave in-window degrades the score", async () => {
    const staffId = "staff-study";
    const rows: Row[] = [
      // Recent denied study spell — well inside the 90-day window.
      {
        id: "study-denied-1",
        staff_id: staffId,
        type: "study",
        status: "denied",
        start_date: isoDaysAgo(20),
        end_date: isoDaysAgo(18),
      },
      ...padRows(1200, staffId, 0, 400), // push table past db-max-rows
    ];
    const leave = await fetchLeaveForStaff(rows, staffId);
    expect(leave.length).toBe(rows.length);

    const baseline = computeWellbeing({
      staffId,
      now: NOW,
      assignments: [],
      changes: [],
      leave: leave.filter((l) => l.status !== "denied"),
      exceptions: [],
    });
    const withDenial = computeWellbeing({
      staffId,
      now: NOW,
      assignments: [],
      changes: [],
      leave,
      exceptions: [],
    });

    const badLeave = withDenial.drivers.find((d) => d.key === "leave")!;
    expect(badLeave.value).toBe(1);
    expect(badLeave.normalised).toBeGreaterThan(0);
    expect(withDenial.score).toBeLessThan(baseline.score);
  });

  it("cancelled compassionate leave in-window degrades the score", async () => {
    const staffId = "staff-compassionate";
    const rows: Row[] = [
      {
        id: "compassionate-cancelled-1",
        staff_id: staffId,
        type: "compassionate",
        status: "cancelled",
        start_date: isoDaysAgo(10),
        end_date: isoDaysAgo(9),
      },
      ...padRows(1500, staffId, 0, 500),
    ];
    const leave = await fetchLeaveForStaff(rows, staffId);

    const withCancellation = computeWellbeing({
      staffId,
      now: NOW,
      assignments: [],
      changes: [],
      leave,
      exceptions: [],
    });
    const badLeave = withCancellation.drivers.find((d) => d.key === "leave")!;
    expect(badLeave.value).toBe(1);
    expect(badLeave.normalised).toBeGreaterThan(0);
  });

  it("approved study and compassionate leave never register as badLeave", async () => {
    const staffId = "staff-approved-only";
    const rows: Row[] = [
      {
        id: "study-approved",
        staff_id: staffId,
        type: "study",
        status: "approved",
        start_date: isoDaysAgo(30),
        end_date: isoDaysAgo(28),
      },
      {
        id: "compassionate-approved",
        staff_id: staffId,
        type: "compassionate",
        status: "approved",
        start_date: isoDaysAgo(15),
        end_date: isoDaysAgo(14),
      },
      ...padRows(1100, staffId, 0, 400),
    ];
    const leave = await fetchLeaveForStaff(rows, staffId);
    // Both approved rows must survive pagination.
    expect(leave.some((l) => l.type === "study" && l.status === "approved")).toBe(true);
    expect(
      leave.some((l) => l.type === "compassionate" && l.status === "approved"),
    ).toBe(true);

    const result = computeWellbeing({
      staffId,
      now: NOW,
      assignments: [],
      changes: [],
      leave,
      exceptions: [],
    });
    expect(result.drivers.find((d) => d.key === "leave")!.value).toBe(0);
  });

  it("denied study/compassionate leave OLDER than the 90-day window is ignored", async () => {
    const staffId = "staff-old-denial";
    const rows: Row[] = [
      {
        id: "study-denied-old",
        staff_id: staffId,
        type: "study",
        status: "denied",
        start_date: isoDaysAgo(200),
        end_date: isoDaysAgo(199),
      },
      {
        id: "compassionate-cancelled-old",
        staff_id: staffId,
        type: "compassionate",
        status: "cancelled",
        start_date: isoDaysAgo(180),
        end_date: isoDaysAgo(179),
      },
      ...padRows(1050, staffId, 0, 400),
    ];
    const leave = await fetchLeaveForStaff(rows, staffId);
    const result = computeWellbeing({
      staffId,
      now: NOW,
      assignments: [],
      changes: [],
      leave,
      exceptions: [],
    });
    expect(result.drivers.find((d) => d.key === "leave")!.value).toBe(0);
  });

  it("multiple denied study/compassionate spells across pages all count", async () => {
    const staffId = "staff-multi";
    // Interleave the denials with padding so the recent denials are NOT all
    // in the first raw page — the ordered pager must still surface them.
    const rows: Row[] = [
      ...padRows(700, staffId, 0, 400),
      {
        id: "d1",
        staff_id: staffId,
        type: "study",
        status: "denied",
        start_date: isoDaysAgo(60),
        end_date: isoDaysAgo(59),
      },
      ...padRows(700, staffId, 700, 1100),
      {
        id: "d2",
        staff_id: staffId,
        type: "compassionate",
        status: "cancelled",
        start_date: isoDaysAgo(40),
        end_date: isoDaysAgo(39),
      },
      {
        id: "d3",
        staff_id: staffId,
        type: "study",
        status: "denied",
        start_date: isoDaysAgo(20),
        end_date: isoDaysAgo(19),
      },
    ];
    const leave = await fetchLeaveForStaff(rows, staffId);
    const result = computeWellbeing({
      staffId,
      now: NOW,
      assignments: [],
      changes: [],
      leave,
      exceptions: [],
    });
    const badLeave = result.drivers.find((d) => d.key === "leave")!;
    expect(badLeave.value).toBe(3);
  });
});
