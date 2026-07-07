/**
 * Regression tests: `weeklyGrid` labels stay consistent when the leave
 * range starts or ends EXACTLY on a week boundary.
 *
 * The grid is Mon-Fri only. Sat/Sun half-sessions are computed by the
 * overlay but never surface in weeklyGrid cells. The interesting edges
 * are therefore:
 *
 *   - Leave starts Monday with `half_day_start='pm'` → Mon AM keeps
 *     the baseline label; Mon PM (and following weekdays inside the
 *     span) flip to "On leave".
 *   - Leave ends Friday with `half_day_end='am'` → Fri AM flips; Fri
 *     PM keeps the baseline label.
 *   - Leave starts Saturday (weekend) → Sat/Sun are invisible; the
 *     first grid-affecting day is the following Monday.
 *   - Leave ends Sunday (weekend) → Sat/Sun are invisible; the last
 *     grid-affecting day is the preceding Friday.
 *
 * Each scenario uses three consecutive weeks of the same shape so the
 * `minRecurrence` threshold is satisfied and every touched cell shows
 * a "3/3" recurrence.
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
  type AssignmentLite,
  type SessionLite,
  type SpecialtyLite,
  type TheatreLite,
} from "./staff-working-patterns";

const STAFF = { id: "s1", full_name: "Dr Boundary", grade: null };
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

function build(assignments: AssignmentLite[]) {
  return buildCurrentPatternResponse({
    profile: STAFF,
    windowDays: 90,
    from: WINDOW_FROM,
    to: WINDOW_TO,
    assignments,
    sessionsById,
    theatresById,
    specialtiesById,
  });
}

function cell(res: ReturnType<typeof build>, session: "am" | "pm", weekday: string) {
  const row = res.weeklyGrid.find((g) => g.session === session)!;
  const c = row.days.find((d) => d.weekday === weekday);
  if (!c) throw new Error(`no cell ${weekday}/${session}`);
  return c;
}

describe("weeklyGrid — leave starts EXACTLY on Monday", () => {
  // Three Mondays with theatre AM+PM and half_day_start='pm' leave
  // starting the same day. The leave extends into Wed of the same week.
  const WEEKS: Array<{ mon: string; wed: string }> = [
    { mon: "2026-01-05", wed: "2026-01-07" },
    { mon: "2026-01-12", wed: "2026-01-14" },
    { mon: "2026-01-19", wed: "2026-01-21" },
  ];
  const baseline: AssignmentLite[] = WEEKS.flatMap(({ mon, wed }) => [
    theatre(mon, "am"),
    theatre(mon, "pm"),
    theatre(wed, "am"),
    theatre(wed, "pm"),
  ]);
  const leaveRows: LeaveRowLite[] = WEEKS.map(({ mon, wed }) =>
    leave({ start_date: mon, end_date: wed, half_day_start: "pm" }),
  );

  it("Mon AM stays 'Main theatres'; Mon PM, Tue, Wed flip to 'On leave' 3/3", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO,
    );
    const res = build(applyLeaveOverlay(baseline, overlay));

    expect(cell(res, "am", "Mon").location).toBe(LOCATION_LABELS.main);
    expect(cell(res, "am", "Mon").recurrence).toBe("3/3");

    expect(cell(res, "pm", "Mon").location).toBe(LOCATION_LABELS.leave);
    expect(cell(res, "pm", "Mon").recurrence).toBe("3/3");

    // Wed is fully covered.
    expect(cell(res, "am", "Wed").location).toBe(LOCATION_LABELS.leave);
    expect(cell(res, "pm", "Wed").location).toBe(LOCATION_LABELS.leave);

    // Days with no baseline commitments (Thu/Fri) remain empty.
    expect(cell(res, "am", "Thu").location).toBeNull();
    expect(cell(res, "am", "Fri").location).toBeNull();
  });
});

describe("weeklyGrid — leave ends EXACTLY on Friday", () => {
  // Three Fridays where theatre lists sit both AM+PM and half_day_end='am'
  // leave ends that same day (leave started the preceding Wed).
  const WEEKS: Array<{ wed: string; fri: string }> = [
    { wed: "2026-01-07", fri: "2026-01-09" },
    { wed: "2026-01-14", fri: "2026-01-16" },
    { wed: "2026-01-21", fri: "2026-01-23" },
  ];
  const baseline: AssignmentLite[] = WEEKS.flatMap(({ wed, fri }) => [
    theatre(wed, "am"),
    theatre(wed, "pm"),
    theatre(fri, "am"),
    theatre(fri, "pm"),
  ]);
  const leaveRows: LeaveRowLite[] = WEEKS.map(({ wed, fri }) =>
    leave({ start_date: wed, end_date: fri, half_day_end: "am" }),
  );

  it("Fri AM flips to 'On leave' 3/3; Fri PM stays 'Main theatres' 3/3", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO,
    );
    const res = build(applyLeaveOverlay(baseline, overlay));

    expect(cell(res, "am", "Fri").location).toBe(LOCATION_LABELS.leave);
    expect(cell(res, "am", "Fri").recurrence).toBe("3/3");
    expect(cell(res, "pm", "Fri").location).toBe(LOCATION_LABELS.main);
    expect(cell(res, "pm", "Fri").recurrence).toBe("3/3");

    // Wed (start day) is fully covered.
    expect(cell(res, "am", "Wed").location).toBe(LOCATION_LABELS.leave);
    expect(cell(res, "pm", "Wed").location).toBe(LOCATION_LABELS.leave);
  });
});

describe("weeklyGrid — leave starts on a Saturday (weekend, off-grid)", () => {
  // Leave Sat → next Tue. Sat/Sun never surface. Only Mon+Tue in the
  // weeklyGrid see any change.
  const WEEKS: Array<{ sat: string; mon: string; tue: string }> = [
    { sat: "2026-01-10", mon: "2026-01-12", tue: "2026-01-13" },
    { sat: "2026-01-17", mon: "2026-01-19", tue: "2026-01-20" },
    { sat: "2026-01-24", mon: "2026-01-26", tue: "2026-01-27" },
  ];
  const baseline: AssignmentLite[] = WEEKS.flatMap(({ mon, tue }) => [
    theatre(mon, "am"),
    theatre(mon, "pm"),
    theatre(tue, "am"),
    theatre(tue, "pm"),
  ]);
  const leaveRows: LeaveRowLite[] = WEEKS.map(({ sat, tue }) =>
    leave({ start_date: sat, end_date: tue }),
  );

  it("Mon & Tue AM+PM all flip to 'On leave' 3/3; Wed/Thu/Fri remain empty", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO,
    );
    const res = build(applyLeaveOverlay(baseline, overlay));

    for (const wd of ["Mon", "Tue"]) {
      for (const half of ["am", "pm"] as const) {
        expect(cell(res, half, wd).location).toBe(LOCATION_LABELS.leave);
        expect(cell(res, half, wd).recurrence).toBe("3/3");
      }
    }
    for (const wd of ["Wed", "Thu", "Fri"]) {
      expect(cell(res, "am", wd).location).toBeNull();
      expect(cell(res, "pm", wd).location).toBeNull();
    }
  });
});

describe("weeklyGrid — leave ends on a Sunday (weekend, off-grid)", () => {
  // Leave Wed → Sun. The Sat/Sun tail never surfaces; Fri is the last
  // grid-affecting day.
  const WEEKS: Array<{ wed: string; fri: string; sun: string }> = [
    { wed: "2026-01-07", fri: "2026-01-09", sun: "2026-01-11" },
    { wed: "2026-01-14", fri: "2026-01-16", sun: "2026-01-18" },
    { wed: "2026-01-21", fri: "2026-01-23", sun: "2026-01-25" },
  ];
  const baseline: AssignmentLite[] = WEEKS.flatMap(({ wed, fri }) => [
    theatre(wed, "am"),
    theatre(wed, "pm"),
    theatre(fri, "am"),
    theatre(fri, "pm"),
  ]);
  const leaveRows: LeaveRowLite[] = WEEKS.map(({ wed, sun }) =>
    leave({ start_date: wed, end_date: sun }),
  );

  it("Fri AM+PM flip to 'On leave' 3/3; Wed AM+PM also flip; Mon/Tue/Thu remain empty", () => {
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id, leaveRows, WINDOW_FROM, WINDOW_TO,
    );
    const res = build(applyLeaveOverlay(baseline, overlay));

    for (const half of ["am", "pm"] as const) {
      expect(cell(res, half, "Wed").location).toBe(LOCATION_LABELS.leave);
      expect(cell(res, half, "Wed").recurrence).toBe("3/3");
      expect(cell(res, half, "Fri").location).toBe(LOCATION_LABELS.leave);
      expect(cell(res, half, "Fri").recurrence).toBe("3/3");
    }
    for (const wd of ["Mon", "Tue", "Thu"]) {
      expect(cell(res, "am", wd).location).toBeNull();
      expect(cell(res, "pm", wd).location).toBeNull();
    }
  });
});
