/**
 * Tests for the approved-leave overlay applied to the staff rota view.
 *
 * Covers:
 *   - `expandApprovedLeaveToAssignments` produces one AM + one PM synthetic
 *     "leave" assignment per full day in the request, clipped to the window.
 *   - `half_day_start` / `half_day_end` markers correctly restrict which
 *     half-sessions are blocked on the first/last day (and both markers on
 *     a single-day request).
 *   - Pending / rejected / cancelled leave never contributes to the overlay
 *     — only `approved` does.
 *   - `applyLeaveOverlay` drops rota assignments that fall on a blocked
 *     half-session and appends the leave-synthetic rows.
 *   - After overlaying, `buildCurrentPatternResponse` promotes the "Leave"
 *     bucket to the dominant cell on regularly-blocked half-sessions, and
 *     leaves other cells untouched.
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
  classifyLocation,
  dominantByHalfSession,
  type AssignmentLite,
  type SessionLite,
  type SpecialtyLite,
  type TheatreLite,
} from "./staff-working-patterns";

const STAFF = { id: "s1", full_name: "Dr Overlay", grade: null };

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

describe("classifyLocation — leave duty type", () => {
  it("maps a synthetic duty_type='leave' assignment to the 'leave' bucket", () => {
    const a: AssignmentLite = {
      staff_id: STAFF.id,
      duty_type: "leave",
      session_date: "2025-01-06",
      session: "am",
      theatre_session_id: null,
    };
    expect(classifyLocation(a, null, theatresById)).toBe("leave");
    expect(LOCATION_LABELS.leave).toBe("On leave");
  });
});

describe("expandApprovedLeaveToAssignments", () => {
  it("emits AM+PM entries for every full day in an approved multi-day leave", () => {
    // Mon 2025-01-06 → Wed 2025-01-08, full days.
    const rows = [leave({ start_date: "2025-01-06", end_date: "2025-01-08" })];
    const out = expandApprovedLeaveToAssignments(STAFF.id, rows, "2025-01-01", "2025-01-31");
    expect(out).toHaveLength(6); // 3 days × 2 halves
    const key = (a: AssignmentLite) => `${a.session_date}|${a.session}`;
    const keys = out.map(key).sort();
    expect(keys).toEqual([
      "2025-01-06|am",
      "2025-01-06|pm",
      "2025-01-07|am",
      "2025-01-07|pm",
      "2025-01-08|am",
      "2025-01-08|pm",
    ]);
    for (const a of out) {
      expect(a.duty_type).toBe("leave");
      expect(a.staff_id).toBe(STAFF.id);
      expect(a.theatre_session_id).toBeNull();
    }
  });

  it("respects half_day_start (PM-only start day) and half_day_end (AM-only end day)", () => {
    // Start PM-only on Mon 2025-01-06, end AM-only on Wed 2025-01-08.
    const rows = [
      leave({
        start_date: "2025-01-06",
        end_date: "2025-01-08",
        half_day_start: "pm",
        half_day_end: "am",
      }),
    ];
    const out = expandApprovedLeaveToAssignments(STAFF.id, rows, "2025-01-01", "2025-01-31");
    const keys = out.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual([
      "2025-01-06|pm", // AM dropped by half_day_start
      "2025-01-07|am",
      "2025-01-07|pm",
      "2025-01-08|am", // PM dropped by half_day_end
    ]);
  });

  it("honours both markers on a single-day request", () => {
    const rows = [
      leave({
        start_date: "2025-01-06",
        end_date: "2025-01-06",
        half_day_start: "pm", // only pm on start day
        half_day_end: "am", // only am on end day → intersection is empty
      }),
    ];
    const out = expandApprovedLeaveToAssignments(STAFF.id, rows, "2025-01-01", "2025-01-31");
    expect(out).toEqual([]);
  });

  it("clips to the [from, to] window and ignores non-approved statuses", () => {
    const rows: LeaveRowLite[] = [
      // Approved but starts before the window: clip.
      leave({ start_date: "2024-12-30", end_date: "2025-01-02" }),
      leave({ start_date: "2025-01-10", end_date: "2025-01-10", status: "pending" }),
      leave({ start_date: "2025-01-11", end_date: "2025-01-11", status: "rejected" }),
      leave({ start_date: "2025-01-12", end_date: "2025-01-12", status: "cancelled" }),
    ];
    const out = expandApprovedLeaveToAssignments(STAFF.id, rows, "2025-01-01", "2025-01-31");
    // Only the approved row survives, clipped to 2025-01-01..2025-01-02.
    const keys = out.map((a) => `${a.session_date}|${a.session}`).sort();
    expect(keys).toEqual([
      "2025-01-01|am",
      "2025-01-01|pm",
      "2025-01-02|am",
      "2025-01-02|pm",
    ]);
  });
});

describe("applyLeaveOverlay", () => {
  it("drops rota assignments whose (date, half) is covered by leave and appends the leave rows", () => {
    // Mon 2025-01-06 AM: main theatre list. Approved leave that same AM.
    const assignments = [theatre("2025-01-06", "am"), theatre("2025-01-06", "pm")];
    const leaveExpanded = expandApprovedLeaveToAssignments(
      STAFF.id,
      [leave({ start_date: "2025-01-06", end_date: "2025-01-06", half_day_end: "am" })],
      "2025-01-01",
      "2025-01-31",
    );
    // Half-day: half_day_end='am' on the single day → only AM leave, PM not blocked.
    const merged = applyLeaveOverlay(assignments, leaveExpanded);
    const byKey = merged.map((a) => `${a.session_date}|${a.session}|${a.duty_type}`).sort();
    expect(byKey).toEqual([
      "2025-01-06|am|leave", // theatre AM was dropped, replaced by leave
      "2025-01-06|pm|theatre", // untouched
    ]);
  });

  it("is a no-op when there is no approved leave", () => {
    const assignments = [theatre("2025-01-06", "am")];
    const merged = applyLeaveOverlay(assignments, []);
    expect(merged).toBe(assignments);
  });
});

describe("dominant location updates after leave overlay", () => {
  const WINDOW_FROM = "2025-01-01";
  const WINDOW_TO = "2025-03-31";
  // Three consecutive Mondays with theatre AM — normally the dominant cell.
  const baseAssignments: AssignmentLite[] = [
    theatre("2025-01-06", "am"),
    theatre("2025-01-13", "am"),
    theatre("2025-01-20", "am"),
  ];

  it("still shows main theatres as dominant when no leave overlaps", () => {
    const grid = dominantByHalfSession(baseAssignments, sessionsById, theatresById, 2);
    expect(grid.am[1]?.bucket).toBe("main");
    expect(grid.am[1]?.count).toBe(3);
  });

  it("promotes 'leave' to the dominant Monday-AM cell when approved leave covers all three Mondays", () => {
    const leaveRows: LeaveRowLite[] = [
      leave({ start_date: "2025-01-06", end_date: "2025-01-06" }),
      leave({ start_date: "2025-01-13", end_date: "2025-01-13" }),
      leave({ start_date: "2025-01-20", end_date: "2025-01-20" }),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      leaveRows,
      WINDOW_FROM,
      WINDOW_TO,
    );
    const effective = applyLeaveOverlay(baseAssignments, overlay);
    const grid = dominantByHalfSession(effective, sessionsById, theatresById, 2);
    // The theatre assignments were dropped; leave now dominates AM Monday.
    expect(grid.am[1]?.bucket).toBe("leave");
    expect(grid.am[1]?.count).toBe(3);
    // Only 'leave' should be counted for that slot — no other bucket present.
    expect(grid.am[1]?.total).toBe(3);
  });

  it("does not overwrite unrelated cells (e.g. Tuesday AM main-theatre list)", () => {
    const assignments: AssignmentLite[] = [
      ...baseAssignments,
      // Two Tuesdays with theatre AM main.
      theatre("2025-01-07", "am"),
      theatre("2025-01-14", "am"),
    ];
    const overlay = expandApprovedLeaveToAssignments(
      STAFF.id,
      [leave({ start_date: "2025-01-06", end_date: "2025-01-06" })],
      WINDOW_FROM,
      WINDOW_TO,
    );
    const effective = applyLeaveOverlay(assignments, overlay);
    const grid = dominantByHalfSession(effective, sessionsById, theatresById, 2);
    // Monday AM was only overlaid on the 6th, so the other two Mondays still win.
    expect(grid.am[1]?.bucket).toBe("main");
    expect(grid.am[1]?.count).toBe(2);
    // Tuesday AM is untouched by leave.
    expect(grid.am[2]?.bucket).toBe("main");
    expect(grid.am[2]?.count).toBe(2);
  });

  it("buildCurrentPatternResponse surfaces the leave-dominant cell with the 'On leave' label", () => {
    const leaveRows: LeaveRowLite[] = [
      leave({ start_date: "2025-01-06", end_date: "2025-01-06" }),
      leave({ start_date: "2025-01-13", end_date: "2025-01-13" }),
      leave({ start_date: "2025-01-20", end_date: "2025-01-20" }),
    ];
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
    expect(am.days[0].weekday).toBe("Mon");
    expect(am.days[0].location).toBe(LOCATION_LABELS.leave);
    expect(am.days[0].recurrence).toBe("3/3");
    // Location breakdown reflects the leave overlay (no theatre assignments left).
    const leaveShare = res.locationBreakdown.find((b) => b.location === LOCATION_LABELS.leave);
    expect(leaveShare?.count).toBe(3);
  });
});
