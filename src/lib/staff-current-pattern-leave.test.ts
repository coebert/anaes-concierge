/**
 * Tests for the chat tool's leave availability merging on top of the
 * computed current-pattern summary.
 *
 * Covers:
 *   - Overlapping leave of different types (annual + study + compassionate)
 *     all surface in `upcoming` and `overlapsByType`, not just the first.
 *   - `onLeaveToday` is true only for **approved** requests that cover today.
 *   - Pending, rejected, and cancelled requests are handled correctly:
 *     pending is surfaced in `upcoming` and counted in `overlapsByType`;
 *     cancelled/rejected are surfaced but excluded from the type counts;
 *     none of them set `onLeaveToday`.
 *   - PII fields (`reason`, `decision_notes`) are scrubbed when the caller
 *     is not the leave owner.
 *   - Allowance is passed through untouched.
 *   - The underlying pattern grid (dominant-per-half-session, weekend/weekday
 *     scope, minCount threshold text) is preserved by the merger and unaffected
 *     by leave rows — leave affects the `leave` block, not the grid.
 */
import { describe, it, expect } from "vitest";
import {
  buildCurrentPatternResponse,
  mergeLeaveAvailability,
  type LeaveRowLite,
} from "./staff-current-pattern";
import {
  LOCATION_LABELS,
  suggestedRegularityThreshold,
  type AssignmentLite,
  type SessionLite,
  type SpecialtyLite,
  type TheatreLite,
} from "./staff-working-patterns";

const STAFF = { id: "s1", full_name: "Dr Leave", grade: null };
const TODAY = "2025-06-16"; // Monday

const theatresById = new Map<string, TheatreLite>([
  ["t-main", { id: "t-main", name: "Main 1", kind: "main" }],
]);
const sessionsById = new Map<string, SessionLite>([
  ["s-main", { id: "s-main", theatre_id: "t-main", specialty_id: null, is_non_sag: false }],
]);
const specialtiesById = new Map<string, SpecialtyLite>();

// A stable pattern with a dominant Monday-AM main-theatres cell, so we can
// assert the grid survives leave merging.
const ASSIGNMENTS: AssignmentLite[] = [
  {
    staff_id: STAFF.id,
    duty_type: "theatre",
    session_date: "2025-04-07",
    session: "am",
    theatre_session_id: "s-main",
  },
  {
    staff_id: STAFF.id,
    duty_type: "theatre",
    session_date: "2025-04-14",
    session: "am",
    theatre_session_id: "s-main",
  },
  {
    staff_id: STAFF.id,
    duty_type: "theatre",
    session_date: "2025-04-21",
    session: "am",
    theatre_session_id: "s-main",
  },
];

function basePattern() {
  return buildCurrentPatternResponse({
    profile: STAFF,
    windowDays: 90,
    from: "2025-03-18",
    to: TODAY,
    assignments: ASSIGNMENTS,
    sessionsById,
    theatresById,
    specialtiesById,
  });
}

function leave(
  overrides: Partial<LeaveRowLite> & { type: LeaveRowLite["type"] } & {
    start_date: string;
    end_date: string;
  },
): LeaveRowLite {
  return {
    status: "approved",
    half_day_start: null,
    half_day_end: null,
    reason: "private reason text",
    decision_notes: "private decision notes",
    ...overrides,
  };
}

const ALLOWANCE = {
  annual_days: 32,
  study_days: 10,
  leave_year_start: "2025-04-01",
};

describe("chat leave availability — mergeLeaveAvailability", () => {
  it("surfaces overlapping annual, study, and compassionate leave together", () => {
    // All three overlap the lookahead window starting at TODAY.
    const rows: LeaveRowLite[] = [
      leave({ type: "annual", start_date: "2025-06-16", end_date: "2025-06-20" }),
      leave({ type: "study", start_date: "2025-06-18", end_date: "2025-06-19" }),
      leave({
        type: "compassionate",
        start_date: "2025-06-19",
        end_date: "2025-06-19",
        status: "pending",
      }),
    ];

    const merged = mergeLeaveAvailability(basePattern(), ALLOWANCE, rows, {
      today: TODAY,
      lookaheadDays: 60,
      isSelf: true,
    });

    expect(merged.leave.upcoming.map((r) => r.type)).toEqual([
      "annual",
      "study",
      "compassionate",
    ]);
    expect(merged.leave.overlapsByType.annual).toBe(1);
    expect(merged.leave.overlapsByType.study).toBe(1);
    expect(merged.leave.overlapsByType.compassionate).toBe(1);
    expect(merged.leave.overlapsByType.sick).toBe(0);
    // Approved annual leave covers today.
    expect(merged.leave.onLeaveToday).toBe(true);
    expect(merged.leave.lookahead).toEqual({
      from: TODAY,
      to: "2025-08-15",
      days: 60,
    });
    // Allowance passes through untouched.
    expect(merged.leave.allowance).toEqual(ALLOWANCE);
  });

  it("only sets onLeaveToday for approved leave that covers today", () => {
    const rows: LeaveRowLite[] = [
      // Pending — covers today but not approved.
      leave({
        type: "annual",
        start_date: "2025-06-15",
        end_date: "2025-06-17",
        status: "pending",
      }),
      // Approved — starts after today.
      leave({ type: "study", start_date: "2025-06-20", end_date: "2025-06-22" }),
    ];

    const merged = mergeLeaveAvailability(basePattern(), null, rows, {
      today: TODAY,
      lookaheadDays: 30,
      isSelf: true,
    });

    expect(merged.leave.onLeaveToday).toBe(false);
    // Both still surface to the model.
    expect(merged.leave.upcoming).toHaveLength(2);
    expect(merged.leave.overlapsByType.annual).toBe(1);
    expect(merged.leave.overlapsByType.study).toBe(1);
  });

  it("excludes cancelled and rejected leave from overlapsByType but still surfaces them", () => {
    const rows: LeaveRowLite[] = [
      leave({
        type: "annual",
        start_date: "2025-06-18",
        end_date: "2025-06-19",
        status: "cancelled",
      }),
      leave({
        type: "study",
        start_date: "2025-06-20",
        end_date: "2025-06-21",
        status: "rejected",
      }),
      leave({
        type: "compassionate",
        start_date: "2025-06-22",
        end_date: "2025-06-22",
        status: "approved",
      }),
    ];

    const merged = mergeLeaveAvailability(basePattern(), null, rows, {
      today: TODAY,
      lookaheadDays: 30,
      isSelf: true,
    });

    // Every row is surfaced so the model can explain what happened.
    expect(merged.leave.upcoming).toHaveLength(3);
    // Only the approved compassionate one counts toward availability impact.
    expect(merged.leave.overlapsByType.annual).toBe(0);
    expect(merged.leave.overlapsByType.study).toBe(0);
    expect(merged.leave.overlapsByType.compassionate).toBe(1);
    // Rejected/cancelled must not mark the person as on leave today.
    expect(merged.leave.onLeaveToday).toBe(false);
  });

  it("scrubs reason and decision_notes for colleagues (non-self) but preserves them for self", () => {
    const rows: LeaveRowLite[] = [
      leave({ type: "annual", start_date: "2025-06-20", end_date: "2025-06-21" }),
    ];

    const asSelf = mergeLeaveAvailability(basePattern(), null, rows, {
      today: TODAY,
      lookaheadDays: 30,
      isSelf: true,
    });
    expect(asSelf.leave.upcoming[0].reason).toBe("private reason text");
    expect(asSelf.leave.upcoming[0].decision_notes).toBe("private decision notes");

    const asColleague = mergeLeaveAvailability(basePattern(), null, rows, {
      today: TODAY,
      lookaheadDays: 30,
      isSelf: false,
    });
    expect(asColleague.leave.upcoming[0].reason).toBeNull();
    expect(asColleague.leave.upcoming[0].decision_notes).toBeNull();
    // Type, dates, status and half-day markers are still visible for scheduling.
    expect(asColleague.leave.upcoming[0].type).toBe("annual");
    expect(asColleague.leave.upcoming[0].status).toBe("approved");
  });

  it("preserves the pattern grid, weekday scope, and regularity assumptions when leave is merged", () => {
    const rows: LeaveRowLite[] = [
      leave({ type: "annual", start_date: "2025-06-16", end_date: "2025-06-20" }),
      leave({
        type: "study",
        start_date: "2025-06-23",
        end_date: "2025-06-24",
        status: "pending",
      }),
    ];

    const merged = mergeLeaveAvailability(basePattern(), ALLOWANCE, rows, {
      today: TODAY,
      lookaheadDays: 60,
      isSelf: true,
    });

    // Dominant grid still identifies Monday-AM main theatres.
    const am = merged.weeklyGrid.find((g) => g.session === "am")!;
    expect(am.days[0].weekday).toBe("Mon");
    expect(am.days[0].location).toBe(LOCATION_LABELS.main);
    expect(am.days[0].recurrence).toBe("3/3");

    // Weekend/weekday scope untouched.
    for (const half of merged.weeklyGrid) {
      expect(half.days.map((d) => d.weekday)).toEqual([
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
      ]);
    }

    // Regularity threshold text still uses the shared minCount/windowDays.
    const threshold = suggestedRegularityThreshold(90);
    expect(merged.regularityThreshold).toBe(threshold);
    expect(merged.assumptions.regularity).toContain(
      `at least ${merged.minRecurrence} distinct dates`,
    );
    expect(merged.assumptions.regularity).toContain(`last ${merged.windowDays} days`);
  });

  it("returns an empty leave block with no overlaps when no leave rows are supplied", () => {
    const merged = mergeLeaveAvailability(basePattern(), ALLOWANCE, [], {
      today: TODAY,
      lookaheadDays: 60,
      isSelf: true,
    });

    expect(merged.leave.upcoming).toEqual([]);
    expect(merged.leave.onLeaveToday).toBe(false);
    for (const type of Object.keys(merged.leave.overlapsByType) as Array<
      keyof typeof merged.leave.overlapsByType
    >) {
      expect(merged.leave.overlapsByType[type]).toBe(0);
    }
    expect(merged.leave.allowance).toEqual(ALLOWANCE);
  });
});
