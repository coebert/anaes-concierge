/**
 * Tests for HALF-DAY (AM/PM) partial-leave handling.
 *
 * `half_day_start` / `half_day_end` on a leave request restrict which
 * AM/PM slots on the first/last day of the request are blocked. These
 * tests verify that:
 *   - Partial-leave overlay only replaces the intended half-session and
 *     leaves the other half untouched (both in the raw overlay output
 *     and after `applyLeaveOverlay`).
 *   - The dominant-per-half-session grid promotes 'leave' only for the
 *     half-session actually blocked, not the whole day.
 *   - `buildCurrentPatternResponse` reflects the split in `weeklyGrid`
 *     (Mon-AM stays 'Main theatres', Mon-PM becomes 'On leave').
 *   - Multi-day requests with markers on both ends correctly leave the
 *     first-day AM and last-day PM available.
 */
import { describe, it, expect } from "vitest";
import {
  applyLeaveOverlay,
  buildCurrentPatternResponse,
  expandApprovedLeaveToAssignments,
  type LeaveRowLite,
} from "./staff-current-pattern";
import {
  LOCATION_LABELS,
  dominantByHalfSession,
  type AssignmentLite,
  type SessionLite,
  type SpecialtyLite,
  type TheatreLite,
} from "./staff-working-patterns";

const STAFF = { id: "s1", full_name: "Dr Halfday", grade: null };
const WINDOW_FROM = "2025-01-01";
const WINDOW_TO = "2025-03-31";

const theatresById = new Map<string, TheatreLite>([
  ["t-main", { id: "t-main", name: "Main 1", kind: "main" }],
]);
const sessionsById = new Map<string, SessionLite>([
  ["s-main", { id: "s-main", theatre_id: "t-main", specialty_id: null, is_non_sag: false }],
]);
const specialtiesById = new Map<string, SpecialtyLite>();

function theatre(date: string, half: "am" | "pm"): AssignmentLite {
  return {
    staff_id: STAFF.id,
    duty_type: "theatre",
    session_date: date,
    session: half,
    theatre_session_id: "s-main",
  };
}

function leave(
  over: Partial<LeaveRowLite> & Pick<LeaveRowLite, "start_date" | "end_date">,
): LeaveRowLite {
  return {
    type: "annual",
    status: "approved",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
    ...over,
  };
}

describe("half-day partial leave — overlay", () => {
  it("PM-only single-day leave (half_day_start='pm') blocks PM but leaves AM available", () => {
    const rows = [
      leave({ start_date: "2025-01-06", end_date: "2025-01-06", half_day_start: "pm" }),
    ];
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, rows, WINDOW_FROM, WINDOW_TO);
    expect(overlay).toEqual([
      {
        staff_id: STAFF.id,
        duty_type: "leave",
        session_date: "2025-01-06",
        session: "pm",
        theatre_session_id: null,
      },
    ]);

    // Both halves have theatre — only PM should be replaced.
    const assignments = [theatre("2025-01-06", "am"), theatre("2025-01-06", "pm")];
    const merged = applyLeaveOverlay(assignments, overlay);
    const summary = merged
      .map((a) => `${a.session_date}|${a.session}|${a.duty_type}`)
      .sort();
    expect(summary).toEqual([
      "2025-01-06|am|theatre", // untouched
      "2025-01-06|pm|leave", // replaced
    ]);
  });

  it("AM-only single-day leave (half_day_end='am') blocks AM but leaves PM available", () => {
    const rows = [
      leave({ start_date: "2025-01-06", end_date: "2025-01-06", half_day_end: "am" }),
    ];
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, rows, WINDOW_FROM, WINDOW_TO);
    expect(overlay.map((a) => a.session)).toEqual(["am"]);

    const assignments = [theatre("2025-01-06", "am"), theatre("2025-01-06", "pm")];
    const merged = applyLeaveOverlay(assignments, overlay);
    const am = merged.find((a) => a.session === "am")!;
    const pm = merged.find((a) => a.session === "pm")!;
    expect(am.duty_type).toBe("leave");
    expect(pm.duty_type).toBe("theatre");
  });

  it("multi-day leave with half_day_start='pm' keeps the first day's AM available", () => {
    // Mon 06 PM → Wed 08 (full days after start). Only the first-day AM
    // is preserved; every other half-session is blocked.
    const rows = [
      leave({
        start_date: "2025-01-06",
        end_date: "2025-01-08",
        half_day_start: "pm",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, rows, WINDOW_FROM, WINDOW_TO);
    const keys = overlay.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual([
      "2025-01-06|pm",
      "2025-01-07|am",
      "2025-01-07|pm",
      "2025-01-08|am",
      "2025-01-08|pm",
    ]);

    // Confirm the theatre list on Mon-06 AM survives the overlay.
    const assignments = [
      theatre("2025-01-06", "am"),
      theatre("2025-01-06", "pm"),
      theatre("2025-01-07", "am"),
    ];
    const merged = applyLeaveOverlay(assignments, overlay);
    const mon06Am = merged.find(
      (a) => a.session_date === "2025-01-06" && a.session === "am",
    );
    expect(mon06Am?.duty_type).toBe("theatre");
    // But Mon-06 PM and Tue-07 AM were replaced by leave.
    const mon06Pm = merged.find(
      (a) => a.session_date === "2025-01-06" && a.session === "pm",
    );
    const tue07Am = merged.find(
      (a) => a.session_date === "2025-01-07" && a.session === "am",
    );
    expect(mon06Pm?.duty_type).toBe("leave");
    expect(tue07Am?.duty_type).toBe("leave");
  });

  it("multi-day leave with half_day_end='am' keeps the last day's PM available", () => {
    const rows = [
      leave({
        start_date: "2025-01-06",
        end_date: "2025-01-08",
        half_day_end: "am",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, rows, WINDOW_FROM, WINDOW_TO);
    const keys = overlay.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual([
      "2025-01-06|am",
      "2025-01-06|pm",
      "2025-01-07|am",
      "2025-01-07|pm",
      "2025-01-08|am",
    ]);
  });
});

describe("half-day partial leave — dominant grid", () => {
  // Three consecutive Mondays with theatre in BOTH AM and PM.
  const MONDAYS = ["2025-01-06", "2025-01-13", "2025-01-20"];
  const baseAssignments: AssignmentLite[] = MONDAYS.flatMap((d) => [
    theatre(d, "am"),
    theatre(d, "pm"),
  ]);

  it("PM-only leave on all three Mondays promotes PM to 'leave' but leaves AM as 'main'", () => {
    const leaveRows: LeaveRowLite[] = MONDAYS.map((d) =>
      leave({ start_date: d, end_date: d, half_day_start: "pm" }),
    );
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      leaveRows,
      WINDOW_FROM,
      WINDOW_TO,
    );
    const effective = applyLeaveOverlay(baseAssignments, overlay);
    const grid = dominantByHalfSession(effective, sessionsById, theatresById, 2);

    // Monday (dow = 1).
    expect(grid.am[1]?.bucket).toBe("main");
    expect(grid.am[1]?.count).toBe(3);
    expect(grid.pm[1]?.bucket).toBe("leave");
    expect(grid.pm[1]?.count).toBe(3);
  });

  it("buildCurrentPatternResponse mirrors the AM/PM split in the weekly grid", () => {
    const leaveRows: LeaveRowLite[] = MONDAYS.map((d) =>
      leave({ start_date: d, end_date: d, half_day_start: "pm" }),
    );
    const effective = applyLeaveOverlay(
      baseAssignments,
      expandApprovedLeaveToAssignments(STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO),
    );
    const res = buildCurrentPatternResponse({
      profile: STAFF,
      windowDays: 90,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      assignments: effective,
      sessionsById,
      theatresById,
      specialtiesById,
    });
    const am = res.weeklyGrid.find((g) => g.session === "am")!;
    const pm = res.weeklyGrid.find((g) => g.session === "pm")!;
    // Mon is the first weekday in the grid.
    expect(am.days[0].weekday).toBe("Mon");
    expect(am.days[0].location).toBe(LOCATION_LABELS.main);
    expect(am.days[0].recurrence).toBe("3/3");
    expect(pm.days[0].weekday).toBe("Mon");
    expect(pm.days[0].location).toBe(LOCATION_LABELS.leave);
    expect(pm.days[0].recurrence).toBe("3/3");
  });

  it("mixed AM-only + PM-only leave on the same Monday blocks both halves independently", () => {
    // Same date has BOTH markers on separate requests: one AM-only, one PM-only.
    const leaveRows: LeaveRowLite[] = [
      leave({ start_date: "2025-01-06", end_date: "2025-01-06", half_day_end: "am" }),
      leave({ start_date: "2025-01-06", end_date: "2025-01-06", half_day_start: "pm" }),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      leaveRows,
      WINDOW_FROM,
      WINDOW_TO,
    );
    const halves = overlay.map((a) => a.session).sort();
    expect(halves).toEqual(["am", "pm"]);
    // Both theatre halves get replaced.
    const merged = applyLeaveOverlay(
      [theatre("2025-01-06", "am"), theatre("2025-01-06", "pm")],
      overlay,
    );
    expect(merged.every((a) => a.duty_type === "leave")).toBe(true);
  });
});
