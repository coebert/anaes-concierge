/**
 * Half-day leave that spans a week boundary (Fri PM → next-Mon AM).
 *
 * Verifies:
 *   1. `expandApprovedLeaveToAssignments` produces the right half-session
 *      set across the intervening Sat/Sun.
 *   2. Window clipping preserves the `half_day_start` marker on the first
 *      day but drops days outside [from, to].
 *   3. `applyLeaveOverlay` + `dominantByHalfSession` + `buildCurrentPatternResponse`
 *      produce the correct weeklyGrid labels when three consecutive weeks
 *      of this pattern make Fri-PM and Mon-AM dominant as "On leave" while
 *      Fri-AM and Mon-PM stay as "Main theatres".
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

const STAFF = { id: "s1", full_name: "Dr Weekboundary", grade: null };
const WINDOW_FROM = "2026-01-01";
const WINDOW_TO = "2026-03-31";

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

function leave(over: Partial<LeaveRowLite> & Pick<LeaveRowLite, "start_date" | "end_date">): LeaveRowLite {
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

describe("half-day leave spanning a week boundary — overlay", () => {
  it("expands Fri-PM → Mon-AM leave into PM, Sat AM/PM, Sun AM/PM, Mon AM", () => {
    // Fri 2026-01-09 PM through Mon 2026-01-12 AM.
    const rows = [
      leave({
        start_date: "2026-01-09",
        end_date: "2026-01-12",
        half_day_start: "pm",
        half_day_end: "am",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, rows, WINDOW_FROM, WINDOW_TO);
    const keys = overlay.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual([
      "2026-01-09|pm", // Fri PM (AM skipped by half_day_start='pm')
      "2026-01-10|am", // Sat
      "2026-01-10|pm",
      "2026-01-11|am", // Sun
      "2026-01-11|pm",
      "2026-01-12|am", // Mon AM (PM skipped by half_day_end='am')
    ]);
    // Sanity: every synthetic assignment is duty_type='leave'.
    expect(overlay.every((a) => a.duty_type === "leave")).toBe(true);
  });

  it("clips a boundary-spanning request to the window: window ends Saturday", () => {
    // Same leave as above, but window ends on Sat 2026-01-10 — Sun/Mon are
    // outside the window and must be dropped. The Fri half_day_start
    // marker on the (still-in-window) first day must be preserved.
    const rows = [
      leave({
        start_date: "2026-01-09",
        end_date: "2026-01-12",
        half_day_start: "pm",
        half_day_end: "am",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      rows,
      "2026-01-01",
      "2026-01-10",
    );
    const keys = overlay.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual(["2026-01-09|pm", "2026-01-10|am", "2026-01-10|pm"]);
  });

  it("clips a boundary-spanning request to the window: window starts Sunday", () => {
    // Window starts Sun 2026-01-11 — Fri/Sat are outside. The Mon
    // half_day_end='am' marker on the (still-in-window) last day must
    // be preserved, and the half_day_start='pm' marker no longer
    // applies (start day is out of window).
    const rows = [
      leave({
        start_date: "2026-01-09",
        end_date: "2026-01-12",
        half_day_start: "pm",
        half_day_end: "am",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      rows,
      "2026-01-11",
      "2026-01-31",
    );
    const keys = overlay.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual([
      "2026-01-11|am", // Sun (fully in-window)
      "2026-01-11|pm",
      "2026-01-12|am", // Mon AM (PM still skipped by half_day_end)
    ]);
  });

  it("applyLeaveOverlay replaces exactly the crossed half-sessions", () => {
    // Fri + Mon theatre both AM+PM. Fri-PM..Mon-AM leave should replace
    // Fri PM and Mon AM only; Fri AM and Mon PM stay as theatre.
    const rows = [
      leave({
        start_date: "2026-01-09",
        end_date: "2026-01-12",
        half_day_start: "pm",
        half_day_end: "am",
      }),
    ];
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, rows, WINDOW_FROM, WINDOW_TO);
    const merged = applyLeaveOverlay(
      [
        theatre("2026-01-09", "am"),
        theatre("2026-01-09", "pm"),
        theatre("2026-01-12", "am"),
        theatre("2026-01-12", "pm"),
      ],
      overlay,
    );
    const map = new Map(
      merged.map((a) => [`${a.session_date}|${a.session}`, a.duty_type]),
    );
    expect(map.get("2026-01-09|am")).toBe("theatre");
    expect(map.get("2026-01-09|pm")).toBe("leave");
    expect(map.get("2026-01-12|am")).toBe("leave");
    expect(map.get("2026-01-12|pm")).toBe("theatre");
  });
});

describe("half-day leave spanning a week boundary — dominant grid & weeklyGrid", () => {
  // Three consecutive Fri→Mon leave spans, with theatre on those Fri and
  // Mon in both AM and PM. Weeks (Fri, Mon) pairs:
  const SPANS: Array<{ fri: string; mon: string }> = [
    { fri: "2026-01-09", mon: "2026-01-12" },
    { fri: "2026-01-16", mon: "2026-01-19" },
    { fri: "2026-01-23", mon: "2026-01-26" },
  ];
  const baseAssignments: AssignmentLite[] = SPANS.flatMap(({ fri, mon }) => [
    theatre(fri, "am"),
    theatre(fri, "pm"),
    theatre(mon, "am"),
    theatre(mon, "pm"),
  ]);
  const leaveRows: LeaveRowLite[] = SPANS.map(({ fri, mon }) =>
    leave({
      start_date: fri,
      end_date: mon,
      half_day_start: "pm",
      half_day_end: "am",
    }),
  );

  it("dominant grid: Fri PM & Mon AM flip to 'leave'; Fri AM & Mon PM stay 'main'", () => {
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO);
    const effective = applyLeaveOverlay(baseAssignments, overlay);
    const grid = dominantByHalfSession(effective, sessionsById, theatresById, 2);

    // Friday is dow=5, Monday is dow=1.
    expect(grid.am[5]?.bucket).toBe("main");
    expect(grid.am[5]?.count).toBe(3);
    expect(grid.pm[5]?.bucket).toBe("leave");
    expect(grid.pm[5]?.count).toBe(3);

    expect(grid.am[1]?.bucket).toBe("leave");
    expect(grid.am[1]?.count).toBe(3);
    expect(grid.pm[1]?.bucket).toBe("main");
    expect(grid.pm[1]?.count).toBe(3);
  });

  it("buildCurrentPatternResponse renders the split in the weeklyGrid", () => {
    const overlay = expandApprovedLeaveToAssignments(STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO);
    const effective = applyLeaveOverlay(baseAssignments, overlay);
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
    const monAm = am.days.find((d) => d.weekday === "Mon")!;
    const monPm = pm.days.find((d) => d.weekday === "Mon")!;
    const friAm = am.days.find((d) => d.weekday === "Fri")!;
    const friPm = pm.days.find((d) => d.weekday === "Fri")!;

    expect(friAm.location).toBe(LOCATION_LABELS.main);
    expect(friAm.recurrence).toBe("3/3");
    expect(friPm.location).toBe(LOCATION_LABELS.leave);
    expect(friPm.recurrence).toBe("3/3");
    expect(monAm.location).toBe(LOCATION_LABELS.leave);
    expect(monAm.recurrence).toBe("3/3");
    expect(monPm.location).toBe(LOCATION_LABELS.main);
    expect(monPm.recurrence).toBe("3/3");
  });
});
