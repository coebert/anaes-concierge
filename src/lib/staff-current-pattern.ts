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
