/**
 * Pure computation for the "current pattern" summary returned by the
 * `get_staff_current_pattern` chat tool and rendered by <CurrentPatternCard />.
 *
 * The chat tool wraps this with the DB fetches; the card computes the same
 * shape client-side. Keeping the post-fetch reduction here means the shape
 * (weekly grid scope, minCount threshold, assumptions text, consultant
 * extras) can be unit-tested without a Supabase client.
 */
import {
  computeConsultantPattern,
  dominantByHalfSession,
  LOCATION_LABELS,
  suggestedRegularityThreshold,
  summariseStaff,
  WEEKDAY_LABELS,
  type AssignmentLite,
  type LocationBucket,
  type SessionLite,
  type SpecialtyLite,
  type StaffGrade,
  type TheatreLite,
} from "@/lib/staff-working-patterns";

export interface CurrentPatternInput {
  profile: { id: string; full_name: string; grade: StaffGrade | null };
  windowDays: number;
  from: string;
  to: string;
  assignments: AssignmentLite[];
  sessionsById: Map<string, SessionLite>;
  theatresById: Map<string, TheatreLite>;
  specialtiesById: Map<string, SpecialtyLite>;
}

export interface CurrentPatternWeeklyCell {
  weekday: string;
  location: string | null;
  recurrence: string | null;
}

export interface CurrentPatternResponse {
  profile: { id: string; full_name: string; grade: StaffGrade | null };
  windowDays: number;
  range: { from: string; to: string };
  assignmentCount: number;
  regularityThreshold: number;
  minRecurrence: number;
  totalSessions: number;
  totalOnCallSessions: number;
  weeklyGrid: Array<{ session: "am" | "pm"; days: CurrentPatternWeeklyCell[] }>;
  locationBreakdown: Array<{ location: string; count: number; percent: number }>;
  topSpecialties: Array<{ specialty: string; count: number }>;
  consultantPattern: {
    onCallType: "none" | "theatre" | "icu" | "both";
    onCallDays: string[];
    sagDays: string[];
    spaAmDays: string[];
    spaPmDays: string[];
  } | null;
  assumptions: {
    method: string;
    regularity: string;
    consultantExtras: string | null;
    locationShare: string;
    dataSource: string;
  };
}

/** Derived `minCount` used by both the card and the chat tool. */
export function deriveMinRecurrence(threshold: number): number {
  return Math.max(2, Math.floor(threshold / 2) + 1);
}

/**
 * Reduce the raw rota rows for one staff member into the same shape the
 * card renders and the chat tool returns to the model.
 */
export function buildCurrentPatternResponse(
  input: CurrentPatternInput,
): CurrentPatternResponse {
  const {
    profile,
    windowDays,
    from,
    to,
    assignments,
    sessionsById,
    theatresById,
    specialtiesById,
  } = input;

  const grade = profile.grade;
  const threshold = suggestedRegularityThreshold(windowDays);
  const minRecurrence = deriveMinRecurrence(threshold);

  const [summary] = summariseStaff(
    [{ id: profile.id, full_name: profile.full_name, grade }],
    assignments,
    sessionsById,
    theatresById,
    specialtiesById,
    { regularityThreshold: threshold },
  );

  const consultantPattern =
    grade === "consultant" || grade === "sas"
      ? computeConsultantPattern(assignments, sessionsById, theatresById, {
          regularityThreshold: threshold,
        })
      : null;

  const dominant = dominantByHalfSession(
    assignments,
    sessionsById,
    theatresById,
    minRecurrence,
  );

  // Mon–Fri only, matching the card's Mon–Fri grid.
  const weeklyGrid = (["am", "pm"] as const).map((half) => ({
    session: half,
    days: [1, 2, 3, 4, 5].map((dow): CurrentPatternWeeklyCell => {
      const cell = dominant[half][dow];
      return {
        weekday: WEEKDAY_LABELS[dow],
        location: cell ? LOCATION_LABELS[cell.bucket] : null,
        recurrence: cell ? `${cell.count}/${cell.total}` : null,
      };
    }),
  }));

  const locationBreakdown = (
    Object.entries(summary.byLocation) as [LocationBucket, number][]
  )
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, count]) => ({
      location: LOCATION_LABELS[bucket],
      count,
      percent:
        summary.totalSessions > 0
          ? Math.round((count / summary.totalSessions) * 100)
          : 0,
    }));

  const toDays = (arr: number[]) => arr.map((d) => WEEKDAY_LABELS[d]);

  return {
    profile: { id: profile.id, full_name: profile.full_name, grade },
    windowDays,
    range: { from, to },
    assignmentCount: assignments.length,
    regularityThreshold: threshold,
    minRecurrence,
    totalSessions: summary.totalSessions,
    totalOnCallSessions: consultantPattern?.totalOnCallSessions ?? 0,
    weeklyGrid,
    locationBreakdown,
    topSpecialties: summary.bySpecialty.slice(0, 6),
    consultantPattern: consultantPattern
      ? {
          onCallType: consultantPattern.onCallType,
          onCallDays: toDays(consultantPattern.onCallWeekdays),
          sagDays: toDays(consultantPattern.privateWeekdays),
          spaAmDays: toDays(consultantPattern.spaAmWeekdays),
          spaPmDays: toDays(consultantPattern.spaPmWeekdays),
        }
      : null,
    assumptions: {
      method:
        "Dominant location per half-session (AM/PM × Mon–Fri): for each cell we group the staff member's assignments in the window by location bucket (theatre list, on-call, SAG, SPA, teaching, admin, leave, other) and pick the bucket that recurs on the most distinct dates.",
      regularity: `A cell is only shown as regular if the winning bucket recurs on at least ${minRecurrence} distinct dates within the last ${windowDays} days (roughly half of the suggested regularity threshold of ${threshold}).`,
      consultantExtras:
        grade === "consultant" || grade === "sas"
          ? "Consultant/SAS on-call, SAG and SPA days are derived from computeConsultantPattern over the same window."
          : null,
      locationShare:
        "The location breakdown and top specialties count every assignment in the window (not just the dominant cell), with specialties inferred from theatre lists.",
      dataSource: `Derived from ${assignments.length} rota assignments in the last ${windowDays} days.`,
    },
  };
}

export type LeaveType =
  | "annual"
  | "study"
  | "compassionate"
  | "sick"
  | "parental"
  | "other"
  | "professional";

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
export type SessionHalf = "am" | "pm" | "eve" | "night";

export interface LeaveRowLite {
  type: LeaveType;
  start_date: string;
  end_date: string;
  status: LeaveStatus;
  half_day_start: SessionHalf | null;
  half_day_end: SessionHalf | null;
  reason: string | null;
  decision_notes: string | null;
}

export interface LeaveAllowanceLite {
  annual_days: number | null;
  study_days: number | null;
  leave_year_start: string | null;
}

export interface LeaveScrubbedRow {
  type: LeaveType;
  start_date: string;
  end_date: string;
  status: LeaveStatus;
  half_day_start: SessionHalf | null;
  half_day_end: SessionHalf | null;
  reason: string | null;
  decision_notes: string | null;
}

export interface LeaveAvailability {
  lookahead: { from: string; to: string; days: number };
  allowance: LeaveAllowanceLite | null;
  upcoming: LeaveScrubbedRow[];
  onLeaveToday: boolean;
  overlapsByType: Record<LeaveType, number>;
}

export interface MergeLeaveOptions {
  today: string;
  lookaheadDays: number;
  isSelf: boolean;
}

/**
 * Merge a leave allowance and the leave requests overlapping the lookahead
 * window onto the computed pattern. Mirrors the chat tool's post-fetch
 * shaping so unit tests can exercise it without a Supabase client.
 *
 * - `onLeaveToday` is true iff at least one **approved** request covers today.
 * - Free-text `reason` / `decision_notes` are stripped when `isSelf` is false.
 * - `overlapsByType` counts every non-cancelled/rejected request in the
 *   lookahead by leave type (including pending), so overlapping annual /
 *   study / compassionate leave are all surfaced to the model, not just
 *   the first one.
 */
export function mergeLeaveAvailability<T>(
  pattern: T,
  allowance: LeaveAllowanceLite | null,
  leaveRows: LeaveRowLite[],
  opts: MergeLeaveOptions,
): T & { leave: LeaveAvailability } {
  const { today, lookaheadDays, isSelf } = opts;
  const until = addDaysIso(today, lookaheadDays);

  const upcoming: LeaveScrubbedRow[] = leaveRows.map((r) => ({
    type: r.type,
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    half_day_start: r.half_day_start,
    half_day_end: r.half_day_end,
    reason: isSelf ? r.reason : null,
    decision_notes: isSelf ? r.decision_notes : null,
  }));

  const overlapsByType: Record<LeaveType, number> = {
    annual: 0,
    study: 0,
    compassionate: 0,
    sick: 0,
    parental: 0,
    other: 0,
    professional: 0,
  };
  for (const r of upcoming) {
    if (r.status === "cancelled" || r.status === "rejected") continue;
    overlapsByType[r.type] += 1;
  }

  const onLeaveToday = upcoming.some(
    (r) => r.status === "approved" && r.start_date <= today && r.end_date >= today,
  );

  return {
    ...pattern,
    leave: {
      lookahead: { from: today, to: until, days: lookaheadDays },
      allowance,
      upcoming,
      onLeaveToday,
      overlapsByType,
    },
  };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Expand approved leave requests into synthetic `AssignmentLite` rows
 * (duty_type = "leave") for every AM/PM half-session covered by the leave,
 * clipped to the [from, to] window and respecting the request's
 * `half_day_start` / `half_day_end` markers:
 *
 *   - `half_day_start = "pm"` on the first day → PM only on that day.
 *   - `half_day_end = "am"` on the last day → AM only on that day.
 *   - Any other combination (or `null`) is treated as a full day.
 *   - Single-day requests honour both markers simultaneously.
 *
 * Only `status === "approved"` requests block the pattern grid; pending/
 * rejected/cancelled are ignored here (they still surface via
 * `mergeLeaveAvailability`).
 *
 * `eve` / `night` halves are not part of the AM/PM grid and are ignored.
 */
export function expandApprovedLeaveToAssignments(
  staffId: string,
  leaveRows: LeaveRowLite[],
  windowFrom: string,
  windowTo: string,
): AssignmentLite[] {
  const out: AssignmentLite[] = [];
  for (const row of leaveRows) {
    if (row.status !== "approved") continue;
    const startClipped = row.start_date < windowFrom ? windowFrom : row.start_date;
    const endClipped = row.end_date > windowTo ? windowTo : row.end_date;
    if (startClipped > endClipped) continue;

    for (
      let iso = startClipped;
      iso <= endClipped;
      iso = addDaysIso(iso, 1)
    ) {
      const halves: Array<"am" | "pm"> = ["am", "pm"];
      for (const half of halves) {
        // Honour half-day markers on the first and last day of the request.
        if (iso === row.start_date && row.half_day_start === "pm" && half === "am") continue;
        if (iso === row.end_date && row.half_day_end === "am" && half === "pm") continue;
        out.push({
          staff_id: staffId,
          duty_type: "leave",
          session_date: iso,
          session: half,
          theatre_session_id: null,
        });
      }
    }
  }
  return out;
}

/**
 * Overlay approved leave on top of rota assignments. Any assignment on a
 * half-session covered by approved leave is removed (the staff member is
 * not actually doing that duty), then the synthetic leave assignments are
 * appended so the dominant-per-half-session computation can promote a
 * "Leave" bucket on regularly-blocked cells.
 */
export function applyLeaveOverlay(
  assignments: AssignmentLite[],
  leaveAssignments: AssignmentLite[],
): AssignmentLite[] {
  if (leaveAssignments.length === 0) return assignments;
  const blocked = new Set<string>();
  for (const a of leaveAssignments) {
    const half = (a.session ?? "").toLowerCase();
    if (half !== "am" && half !== "pm") continue;
    blocked.add(`${a.session_date}|${half}`);
  }
  const kept = assignments.filter((a) => {
    const half = (a.session ?? "").toLowerCase();
    if (half !== "am" && half !== "pm") return true;
    return !blocked.has(`${a.session_date}|${half}`);
  });
  return [...kept, ...leaveAssignments];
}

