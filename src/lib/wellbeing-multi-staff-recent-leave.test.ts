import { describe, expect, it } from "vitest";
import { fetchAllPaged } from "./supabase-chunked";
import { computeWellbeing, type LeaveLite } from "@/features/wellbeing/wellbeing-score";

/**
 * Companion regression to `wellbeing-tucker-regression.test.ts`.
 *
 * The Tucker bug wasn't Tucker-specific — any staff member whose most recent
 * approved leave landed past Supabase's silent 1000-row cap would show a
 * stale "days since last leave" figure. This test uses the same fixture
 * shape (fixed rota + leave rows, filler noise pushing rows past the cap)
 * but checks recent-leave dates for MULTIPLE staff at once and across
 * MULTIPLE leave types (annual, study, compassionate).
 *
 * Guarantees:
 *   1. The paginated + ordered read surfaces each staff member's real recent
 *      approved leave, per type, regardless of position in the raw table.
 *   2. The legacy single unordered `.range(0, 19999)` reproduces the stale
 *      result for at least one staff/type combination — locking in why the
 *      pagination fix must stay in place for every staff member, not just
 *      Dr S Tucker.
 */

const DB_MAX_ROWS = 1000;
const TODAY = new Date("2026-07-10T00:00:00Z");
const DAY_MS = 86_400_000;

type LeaveType = "annual" | "study" | "compassionate";

type Row = {
  id: string;
  staff_id: string;
  staff_name: string;
  type: LeaveType | "sick";
  status: "approved" | "rejected" | "pending" | "cancelled";
  start_date: string;
  end_date: string;
};

function isoDaysAgo(days: number): string {
  return new Date(TODAY.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function daysSince(iso: string): number {
  return Math.floor((TODAY.getTime() - new Date(iso).getTime()) / DAY_MS);
}

type OrderCall = { key: keyof Row; ascending: boolean };

function makeFakeTable(rows: Row[]) {
  let orderKey: keyof Row | null = null;
  let ascending = true;
  const orderCalls: OrderCall[] = [];
  const rangeCalls: Array<{ from: number; to: number; orderedBy: OrderCall | null }> = [];
  const build = {
    orderCalls,
    rangeCalls,
    order(key: keyof Row, opts: { ascending: boolean }) {
      orderKey = key;
      ascending = opts.ascending;
      orderCalls.push({ key, ascending: opts.ascending });
      return build;
    },
    async range(from: number, to: number) {
      rangeCalls.push({
        from,
        to,
        orderedBy: orderKey ? { key: orderKey, ascending } : null,
      });
      const source = rows.slice();
      if (orderKey) {
        const k = orderKey;
        const dir = ascending ? 1 : -1;
        source.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir);
      }
      const cappedTo = Math.min(to, from + DB_MAX_ROWS - 1);
      return { data: source.slice(from, cappedTo + 1), error: null };
    },
  };
  return build;
}

function lastApproved(
  staffId: string,
  type: LeaveType,
  leave: readonly Row[],
): Row | null {
  return (
    leave
      .filter(
        (l) =>
          l.staff_id === staffId && l.type === type && l.status === "approved",
      )
      .sort((a, b) => b.end_date.localeCompare(a.end_date))[0] ?? null
  );
}

/**
 * Fixed fixture. Three staff — each with a stale approved spell (>300 days
 * ago) AND a real recent approved spell (7..25 days ago), spread across
 * annual / study / compassionate. Filler rows for other staff pad well past
 * the 1000-row cap so each staff's recent row sits after the cap in the
 * physical (unordered) read.
 */
function buildFixture() {
  const staff = [
    { id: "staff-a", name: "Dr A. Patel", type: "annual" as const, recentEnd: 12, recentStart: 18, staleEnd: 340 },
    { id: "staff-b", name: "Dr B. Kim", type: "study" as const, recentEnd: 7, recentStart: 10, staleEnd: 310 },
    { id: "staff-c", name: "Dr C. Novak", type: "compassionate" as const, recentEnd: 25, recentStart: 27, staleEnd: 355 },
  ];
  const fillerStaff = Array.from({ length: 20 }, (_, i) => ({
    id: `staff-filler-${i}`,
    name: `Filler ${i}`,
  }));

  const rows: Row[] = [];
  let counter = 0;
  const push = (r: Omit<Row, "id">) => rows.push({ id: `r-${counter++}`, ...r });

  // Stale approved spells first — these are what the buggy read surfaces.
  for (const s of staff) {
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: s.type,
      status: "approved",
      start_date: isoDaysAgo(s.staleEnd + 5),
      end_date: isoDaysAgo(s.staleEnd),
    });
  }

  // Noise: 1500+ approved annual rows for filler staff, pushing well past the cap.
  while (rows.length < 1600) {
    const f = fillerStaff[rows.length % fillerStaff.length];
    const d = 200 + (rows.length % 400);
    push({
      staff_id: f.id,
      staff_name: f.name,
      type: "annual",
      status: "approved",
      start_date: isoDaysAgo(d + 5),
      end_date: isoDaysAgo(d),
    });
  }

  // Real recent approved spells for each staff — placed AFTER the cap on
  // purpose, interleaved with red herrings (rejected / wrong-type).
  for (const s of staff) {
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: s.type,
      status: "rejected",
      start_date: isoDaysAgo(4),
      end_date: isoDaysAgo(2),
    });
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: "sick",
      status: "approved",
      start_date: isoDaysAgo(50),
      end_date: isoDaysAgo(48),
    });
    push({
      staff_id: s.id,
      staff_name: s.name,
      type: s.type,
      status: "approved",
      start_date: isoDaysAgo(s.recentStart),
      end_date: isoDaysAgo(s.recentEnd),
    });
  }

  return { staff, rows };
}

describe("Multi-staff recent-leave regression (fixed fixture)", () => {
  it("paginated + ordered read surfaces each staff member's real recent leave, per type", async () => {
    const { staff, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    expect(fetched.length).toBe(rows.length);

    // Every `.range(...)` call must have been preceded by a consistent
    // `.order('end_date', { ascending: false })` — no page can slip through
    // unordered, and no page may switch key or direction mid-scan. This is
    // what makes the pagination result deterministic across the row cap.
    expect(table.rangeCalls.length).toBeGreaterThan(1);
    for (const call of table.rangeCalls) {
      expect(call.orderedBy).not.toBeNull();
      expect(call.orderedBy!.key).toBe("end_date");
      expect(call.orderedBy!.ascending).toBe(false);
    }
    for (const call of table.orderCalls) {
      expect(call.key).toBe("end_date");
      expect(call.ascending).toBe(false);
    }

    for (const s of staff) {
      const last = lastApproved(s.id, s.type, fetched);
      expect(last, `no recent ${s.type} for ${s.name}`).not.toBeNull();
      expect(last!.start_date).toBe(isoDaysAgo(s.recentStart));
      expect(last!.end_date).toBe(isoDaysAgo(s.recentEnd));
      expect(daysSince(last!.end_date)).toBe(s.recentEnd);
      expect(daysSince(last!.end_date)).toBeLessThan(90);
    }

    // Score contribution: the in-window rejected spell for each staff (2 days ago,
    // hidden behind the row cap) must now flow into computeWellbeing via the
    // `leave` driver. Compare against a "legacy view" — the same fetched set
    // with each staff's recent rows stripped — to prove the paginated dates
    // both appear in the returned list AND move the score.
    const NOW = TODAY;
    for (const s of staff) {
      const paginatedLeave: LeaveLite[] = fetched
        .filter((r) => r.staff_id === s.id)
        .map((r) => ({
          staff_id: r.staff_id,
          status: r.status,
          type: r.type,
          start_date: r.start_date,
          end_date: r.end_date,
        }));
      const legacyLeave: LeaveLite[] = paginatedLeave.filter(
        (l) => daysSince(l.start_date) > 90,
      );

      const paginatedScore = computeWellbeing({
        staffId: s.id,
        now: NOW,
        assignments: [],
        changes: [],
        leave: paginatedLeave,
        exceptions: [],
      });
      const legacyScore = computeWellbeing({
        staffId: s.id,
        now: NOW,
        assignments: [],
        changes: [],
        leave: legacyLeave,
        exceptions: [],
      });

      const paginatedLeaveDriver = paginatedScore.drivers.find((d) => d.key === "leave")!;
      const legacyLeaveDriver = legacyScore.drivers.find((d) => d.key === "leave")!;

      // The fixture plants exactly ONE in-window rejected row per staff (2 days
      // ago). Pin the driver to that specific row — value, normalised harm
      // (1 / cap 3), weight (0.10), and the resulting composite score.
      const rejectedRowsInWindow = paginatedLeave.filter(
        (l) =>
          (l.status === "rejected" || l.status === "cancelled") &&
          daysSince(l.start_date) <= 90 &&
          daysSince(l.start_date) >= 0,
      );
      expect(rejectedRowsInWindow).toHaveLength(1);
      expect(rejectedRowsInWindow[0].start_date).toBe(isoDaysAgo(4));
      expect(rejectedRowsInWindow[0].end_date).toBe(isoDaysAgo(2));

      expect(paginatedLeaveDriver.value).toBe(1);
      expect(paginatedLeaveDriver.normalised).toBeCloseTo(1 / 3, 10);
      expect(paginatedLeaveDriver.weight).toBe(0.1);
      // Legacy view misses it → leave driver stays at 0.
      expect(legacyLeaveDriver.value).toBe(0);
      expect(legacyLeaveDriver.normalised).toBe(0);
      // Exact composite delta: the only driver that changed is `leave`, so
      // paginatedScore = round(legacyHarmMinus100 - 100 * (1/3) * 0.10).
      const expectedDelta = Math.round(100 * (1 / 3) * 0.1);
      expect(legacyScore.score - paginatedScore.score).toBe(expectedDelta);
    }
  });

  it("legacy single unordered .range(0, 19999) inflates 'days since last leave' AND misses the score penalty", async () => {
    const { staff, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const { data, error } = await table.range(0, 19999);
    expect(error).toBeNull();
    expect(data.length).toBe(DB_MAX_ROWS);

    const NOW = TODAY;
    for (const s of staff) {
      const last = lastApproved(s.id, s.type, data);
      expect(last, `${s.name} should have a stale row visible`).not.toBeNull();
      // Under the legacy path only the ancient spell is visible.
      expect(last!.end_date).toBe(isoDaysAgo(s.staleEnd));
      expect(daysSince(last!.end_date)).toBeGreaterThan(300);

      // And the truncated slice has zero in-window rejected spells for this
      // staff — so the wellbeing `leave` driver stays flat at 0, understating
      // the real harm.
      const legacyLeave: LeaveLite[] = data
        .filter((r) => r.staff_id === s.id)
        .map((r) => ({
          staff_id: r.staff_id,
          status: r.status,
          type: r.type,
          start_date: r.start_date,
          end_date: r.end_date,
        }));
      const result = computeWellbeing({
        staffId: s.id,
        now: NOW,
        assignments: [],
        changes: [],
        leave: legacyLeave,
        exceptions: [],
      });
      const leaveDriver = result.drivers.find((d) => d.key === "leave")!;
      expect(leaveDriver.value).toBe(0);
      expect(leaveDriver.normalised).toBe(0);
    }
  });

  it("each staff's recent approved row sits past the 1000-row cap in the raw read", async () => {
    const { staff, rows } = buildFixture();
    const table = makeFakeTable(rows);

    const { data: firstPageUnordered } = await table.range(0, DB_MAX_ROWS - 1);
    for (const s of staff) {
      const onFirstPage = firstPageUnordered.some(
        (r) =>
          r.staff_id === s.id &&
          r.type === s.type &&
          r.status === "approved" &&
          r.end_date === isoDaysAgo(s.recentEnd),
      );
      expect(onFirstPage, `${s.name}'s recent row must NOT be on page 1`).toBe(false);
    }

    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    for (const s of staff) {
      const approved = fetched
        .filter(
          (r) => r.staff_id === s.id && r.type === s.type && r.status === "approved",
        )
        .map((r) => r.end_date);
      expect(approved).toEqual([isoDaysAgo(s.recentEnd), isoDaysAgo(s.staleEnd)]);
    }
  });

  it("handles leave rows on the 90-day window boundary — inclusive at day 90, exclusive at day 91", async () => {
    // Small dedicated fixture: one staff, four rejected spells straddling the
    // window edge, plus filler to still exercise pagination through the cap.
    const STAFF = { id: "staff-boundary", name: "Dr Boundary" };
    const rows: Row[] = [];
    let counter = 0;
    const push = (r: Omit<Row, "id">) => rows.push({ id: `b-${counter++}`, ...r });

    // 1) Denied, start_date exactly on the window start (90 days ago) → IN.
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "annual",
      status: "rejected",
      start_date: isoDaysAgo(90),
      end_date: isoDaysAgo(85),
    });
    // 2) Denied, start_date 91 days ago → OUT (one day past the boundary).
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "annual",
      status: "rejected",
      start_date: isoDaysAgo(91),
      end_date: isoDaysAgo(86),
    });
    // 3) Cancelled today (start_date 0 days ago) → IN (upper edge).
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "annual",
      status: "cancelled",
      start_date: isoDaysAgo(0),
      end_date: isoDaysAgo(0),
    });
    // 4) Denied with start_date 89 (IN) but end_date 100 (OUT) — the driver
    //    keys off start_date, so this must still count.
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "annual",
      status: "rejected",
      start_date: isoDaysAgo(89),
      end_date: isoDaysAgo(100),
    });

    // Filler to push the boundary rows past the 1000-row cap so pagination
    // is genuinely exercised.
    while (rows.length < 1400) {
      push({
        staff_id: `filler-${rows.length % 20}`,
        staff_name: `Filler ${rows.length % 20}`,
        type: "annual",
        status: "approved",
        start_date: isoDaysAgo(200 + (rows.length % 300) + 5),
        end_date: isoDaysAgo(200 + (rows.length % 300)),
      });
    }

    const table = makeFakeTable(rows);
    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    expect(fetched.length).toBe(rows.length);

    // Ordering: every page fetched with end_date desc, no exceptions.
    for (const call of table.rangeCalls) {
      expect(call.orderedBy).toEqual({ key: "end_date", ascending: false });
    }

    // Returned date list for this staff, ordered end_date desc.
    const staffRows = fetched.filter((r) => r.staff_id === STAFF.id);
    expect(staffRows.map((r) => r.end_date)).toEqual([
      isoDaysAgo(0), // cancelled today
      isoDaysAgo(85), // rejected, day-90 boundary
      isoDaysAgo(86), // rejected, day-91 (out of window but still returned)
      isoDaysAgo(100), // rejected with start=89 (in-window) but end=100
    ]);

    // Score contribution: three of the four rows are in-window bad leave
    // (rows 1, 3, 4). Row 2 (start_date 91 days ago) must NOT count.
    const leaveInput: LeaveLite[] = staffRows.map((r) => ({
      staff_id: r.staff_id,
      status: r.status,
      type: r.type,
      start_date: r.start_date,
      end_date: r.end_date,
    }));

    const result = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: leaveInput,
      exceptions: [],
    });
    const leaveDriver = result.drivers.find((d) => d.key === "leave")!;
    expect(leaveDriver.value).toBe(3);
    // Cap is 3, so normalised saturates at exactly 1.0 on this boundary set.
    expect(leaveDriver.normalised).toBe(1);
    expect(leaveDriver.weight).toBe(0.1);

    // Verify the exclusion is specifically the 91-days-ago row — drop it,
    // reduce value to 2, normalised to 2/3.
    const withoutBoundary: LeaveLite[] = leaveInput.filter(
      (l) => l.start_date !== isoDaysAgo(91),
    );
    // (No-op: the 91-day row was already excluded from the score above.
    // This branch removes it from the *input* to confirm the score is
    // identical — proving the driver truly ignored it, not merely capped.)
    const resultWithoutOutOfWindow = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: withoutBoundary,
      exceptions: [],
    });
    expect(resultWithoutOutOfWindow.score).toBe(result.score);
    expect(
      resultWithoutOutOfWindow.drivers.find((d) => d.key === "leave")!.value,
    ).toBe(3);

    // And dropping an in-window row (the day-90 boundary one) must lower
    // the driver — confirming day 90 is inclusive.
    const withoutDay90: LeaveLite[] = leaveInput.filter(
      (l) => l.start_date !== isoDaysAgo(90),
    );
    const resultWithoutDay90 = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: withoutDay90,
      exceptions: [],
    });
    expect(
      resultWithoutDay90.drivers.find((d) => d.key === "leave")!.value,
    ).toBe(2);
    expect(resultWithoutDay90.score).toBeGreaterThan(result.score);
  });

  it("cancelled compassionate + cancelled study leave side by side: date lists per type and combined score contribution", async () => {
    // One staff with recent cancelled spells in BOTH compassionate and study.
    // Each type also has an older approved spell (visible) and an older
    // cancelled spell (out of window) so we can pin the "recent" filter.
    const STAFF = { id: "staff-mixed", name: "Dr Mixed" };
    const rows: Row[] = [];
    let counter = 0;
    const push = (r: Omit<Row, "id">) => rows.push({ id: `m-${counter++}`, ...r });

    // OLD approved (still returned in the list — visible but not "bad leave").
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "compassionate",
      status: "approved",
      start_date: isoDaysAgo(200),
      end_date: isoDaysAgo(198),
    });
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "study",
      status: "approved",
      start_date: isoDaysAgo(180),
      end_date: isoDaysAgo(178),
    });
    // OLD cancelled (out of the 90-day window — MUST NOT count toward the score).
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "compassionate",
      status: "cancelled",
      start_date: isoDaysAgo(150),
      end_date: isoDaysAgo(148),
    });
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "study",
      status: "cancelled",
      start_date: isoDaysAgo(160),
      end_date: isoDaysAgo(158),
    });

    // Filler to push the recent rows past the 1000-row cap.
    while (rows.length < 1300) {
      push({
        staff_id: `filler-${rows.length % 20}`,
        staff_name: `Filler ${rows.length % 20}`,
        type: "annual",
        status: "approved",
        start_date: isoDaysAgo(200 + (rows.length % 300) + 5),
        end_date: isoDaysAgo(200 + (rows.length % 300)),
      });
    }

    // RECENT cancelled — the pair we're asserting on. Placed after the cap.
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "compassionate",
      status: "cancelled",
      start_date: isoDaysAgo(20),
      end_date: isoDaysAgo(18),
    });
    push({
      staff_id: STAFF.id,
      staff_name: STAFF.name,
      type: "study",
      status: "cancelled",
      start_date: isoDaysAgo(10),
      end_date: isoDaysAgo(8),
    });

    const table = makeFakeTable(rows);
    const fetched = await fetchAllPaged<Row>(() =>
      table.order("end_date", { ascending: false }),
    );
    expect(fetched.length).toBe(rows.length);
    // Ordering discipline holds across the paginated scan.
    for (const call of table.rangeCalls) {
      expect(call.orderedBy).toEqual({ key: "end_date", ascending: false });
    }

    const staffRows = fetched.filter((r) => r.staff_id === STAFF.id);

    // Per-type returned date lists (end_date desc).
    const compassionate = staffRows.filter((r) => r.type === "compassionate");
    const study = staffRows.filter((r) => r.type === "study");
    expect(compassionate.map((r) => ({ status: r.status, end_date: r.end_date }))).toEqual([
      { status: "cancelled", end_date: isoDaysAgo(18) },
      { status: "cancelled", end_date: isoDaysAgo(148) },
      { status: "approved", end_date: isoDaysAgo(198) },
    ]);
    expect(study.map((r) => ({ status: r.status, end_date: r.end_date }))).toEqual([
      { status: "cancelled", end_date: isoDaysAgo(8) },
      { status: "cancelled", end_date: isoDaysAgo(158) },
      { status: "approved", end_date: isoDaysAgo(178) },
    ]);

    // Most-recent cancelled per type — the values the UI surfaces.
    const lastCancelled = (type: LeaveType) =>
      staffRows
        .filter((r) => r.type === type && r.status === "cancelled")
        .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
    expect(lastCancelled("compassionate")!.end_date).toBe(isoDaysAgo(18));
    expect(lastCancelled("study")!.end_date).toBe(isoDaysAgo(8));

    // Score contribution: both recent cancellations are in-window bad leave.
    // The two OLD cancellations sit outside the 90d window and must NOT count.
    const leaveInput: LeaveLite[] = staffRows.map((r) => ({
      staff_id: r.staff_id,
      status: r.status,
      type: r.type,
      start_date: r.start_date,
      end_date: r.end_date,
    }));
    const result = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: leaveInput,
      exceptions: [],
    });
    const leaveDriver = result.drivers.find((d) => d.key === "leave")!;
    // Two in-window bad-leave rows (both cancelled), cap 3.
    expect(leaveDriver.value).toBe(2);
    expect(leaveDriver.normalised).toBeCloseTo(2 / 3, 10);
    expect(leaveDriver.weight).toBe(0.1);

    // Drop the compassionate cancellation → value 1 (study only).
    const studyOnly: LeaveLite[] = leaveInput.filter(
      (l) => !(l.type === "compassionate" && l.status === "cancelled" && l.start_date === isoDaysAgo(20)),
    );
    const studyOnlyResult = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: studyOnly,
      exceptions: [],
    });
    expect(studyOnlyResult.drivers.find((d) => d.key === "leave")!.value).toBe(1);

    // Drop the study cancellation → value 1 (compassionate only). Confirms
    // both types contribute symmetrically to the same driver.
    const compassionateOnly: LeaveLite[] = leaveInput.filter(
      (l) => !(l.type === "study" && l.status === "cancelled" && l.start_date === isoDaysAgo(10)),
    );
    const compassionateOnlyResult = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: compassionateOnly,
      exceptions: [],
    });
    expect(
      compassionateOnlyResult.drivers.find((d) => d.key === "leave")!.value,
    ).toBe(1);
    expect(compassionateOnlyResult.score).toBe(studyOnlyResult.score);

    // Composite delta: driver went from 0 (drop both) to 2/3 saturation.
    const noneResult = computeWellbeing({
      staffId: STAFF.id,
      now: TODAY,
      assignments: [],
      changes: [],
      leave: leaveInput.filter(
        (l) =>
          !(
            l.status === "cancelled" &&
            (l.start_date === isoDaysAgo(10) || l.start_date === isoDaysAgo(20))
          ),
      ),
      exceptions: [],
    });
    expect(noneResult.drivers.find((d) => d.key === "leave")!.value).toBe(0);
    expect(noneResult.score - result.score).toBe(Math.round(100 * (2 / 3) * 0.1));
  });
});
