/**
 * Computes per-anaesthetist working-pattern summaries from rota data.
 *
 * Two kinds of summary:
 *   - Location + specialty counts (day surgery / main / NHH-private /
 *     obstetrics / ICU) for every anaesthetic staff member.
 *   - Consultant working pattern: normal working weekdays, private (SAG)
 *     days, on-call weekdays, and on-call cover type (theatre, ICU, or
 *     both) — derived from the recent rota history.
 *
 * Pure functions — no I/O — so this module is trivially unit-testable.
 */

export type StaffGrade = "consultant" | "sas" | "trainee";

export type TheatreKind = "main" | "day_surgery" | "private";

export type DutyType =
  | "theatre"
  | "spa"
  | "admin"
  | "teaching"
  | "non_clinical"
  | "obstetrics"
  | "obstetrics_2nd"
  | "icu_ct2_plus"
  | "icu_trainee"
  | "icu_consultant_oncall"
  | "general_consultant_oncall"
  | "consultant_in_charge"
  | "nhh_oncall"
  | "registrar_oncall"
  | "sho_oncall";

export interface TheatreLite {
  id: string;
  name: string;
  kind: TheatreKind | null;
}

export interface SpecialtyLite {
  id: string;
  name: string;
}

export interface SessionLite {
  id: string;
  theatre_id: string | null;
  specialty_id: string | null;
  is_non_sag: boolean | null;
}

export interface AssignmentLite {
  staff_id: string;
  duty_type: DutyType | string | null;
  session_date: string; // YYYY-MM-DD
  session: string | null;
  theatre_session_id: string | null;
}

export type LocationBucket =
  | "day_surgery"
  | "main"
  | "private_sag"
  | "private_non_sag"
  | "obstetrics"
  | "icu"
  | "leave"
  | "other";


const ICU_DUTIES = new Set<string>([
  "icu_ct2_plus",
  "icu_trainee",
  "icu_consultant_oncall",
]);

const OBSTETRICS_DUTIES = new Set<string>(["obstetrics", "obstetrics_2nd"]);

const CONSULTANT_ONCALL_THEATRE_DUTIES = new Set<string>([
  "general_consultant_oncall",
  "consultant_in_charge",
  "nhh_oncall",
]);
const CONSULTANT_ONCALL_ICU_DUTIES = new Set<string>([
  "icu_consultant_oncall",
]);

const NON_WORKING_ONCALL = new Set<string>([
  ...CONSULTANT_ONCALL_THEATRE_DUTIES,
  ...CONSULTANT_ONCALL_ICU_DUTIES,
  "registrar_oncall",
  "sho_oncall",
]);

/**
 * Classify a rota assignment into a coarse location bucket. The bucket is
 * the primary axis of the per-staff summary. Assignments that don't map
 * onto any of the recognised locations (e.g. teaching, admin, on-call
 * with no theatre) fall into `other`.
 */
export function classifyLocation(
  assignment: AssignmentLite,
  session: SessionLite | null,
  theatresById: Map<string, TheatreLite>,
): LocationBucket {
  const duty = assignment.duty_type ?? "";
  if (duty === "leave") return "leave";
  if (ICU_DUTIES.has(duty)) return "icu";
  if (OBSTETRICS_DUTIES.has(duty)) return "obstetrics";

  if (duty !== "theatre") return "other";
  if (!session || !session.theatre_id) return "other";
  const theatre = theatresById.get(session.theatre_id);
  if (!theatre) return "other";

  if (theatre.kind === "day_surgery") return "day_surgery";
  if (theatre.kind === "private") {
    return session.is_non_sag ? "private_non_sag" : "private_sag";
  }
  return "main";
}

export const LOCATION_LABELS: Record<LocationBucket, string> = {
  day_surgery: "Day surgery",
  main: "Main theatres",
  private_sag: "NHH (SAG / private)",
  private_non_sag: "NHH (non-SAG cover)",
  obstetrics: "Obstetrics",
  icu: "ICU",
  leave: "On leave",
  other: "Other / non-clinical",
};

export const LOCATION_ORDER: LocationBucket[] = [
  "main",
  "day_surgery",
  "private_sag",
  "private_non_sag",
  "obstetrics",
  "icu",
  "leave",
  "other",
];


export interface StaffSummary {
  staff_id: string;
  full_name: string;
  grade: StaffGrade | null;
  totalSessions: number;
  byLocation: Record<LocationBucket, number>;
  bySpecialty: Array<{ specialty: string; count: number }>;
  consultantPattern: ConsultantPattern | null;
}

export interface ConsultantPattern {
  /** Days-of-week where the consultant works a normal (non-on-call) duty. */
  workingWeekdays: number[]; // 1..5 (Mon..Fri)
  /** Days-of-week where the consultant is normally on a private (SAG) list. */
  privateWeekdays: number[];
  /** Days-of-week where the consultant is on-call in the recent window. */
  onCallWeekdays: number[];
  /** Cover type of the consultant's on-call sessions. */
  onCallType: "none" | "theatre" | "icu" | "both";
  /** Regular AM/PM working weekdays — used to identify full vs half days. */
  amWorkingWeekdays: number[];
  pmWorkingWeekdays: number[];
  /** Regular SPA weekdays split by half-session. */
  spaAmWeekdays: number[];
  spaPmWeekdays: number[];
  /** Total working sessions counted, used as a coverage indicator. */
  totalWorkingSessions: number;
  /** Total on-call sessions counted, used as a coverage indicator. */
  totalOnCallSessions: number;
  /** Threshold applied when picking "regular" weekdays. */
  regularityThreshold: number;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

/** UTC day-of-week (0=Sun … 6=Sat) for an ISO YYYY-MM-DD date. */
export function isoDayOfWeek(iso: string): number | null {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

/**
 * Compute a consultant's regular working pattern from their assignments.
 *
 * Regularity rule: a weekday counts as "normally worked" when the
 * consultant has a duty on that weekday in at least `regularityThreshold`
 * distinct calendar dates within the window. Default threshold scales
 * with the window size — for a 90-day window the default is 3 (roughly
 * every fourth week), which cuts noise from one-off leave cover while
 * still catching every-fortnight patterns.
 */
export function computeConsultantPattern(
  assignments: AssignmentLite[],
  sessionsById: Map<string, SessionLite>,
  theatresById: Map<string, TheatreLite>,
  opts: { regularityThreshold?: number } = {},
): ConsultantPattern {
  const threshold = opts.regularityThreshold ?? 3;

  // Dates-per-weekday counters, keyed on 0..6.
  const workingDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  const privateDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  const onCallDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  const amWorkingDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  const pmWorkingDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  const spaAmDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  const spaPmDates: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());

  let totalWorking = 0;
  let totalOnCall = 0;
  let anyTheatreOnCall = false;
  let anyIcuOnCall = false;

  for (const a of assignments) {
    const dow = isoDayOfWeek(a.session_date);
    if (dow == null) continue;
    const duty = a.duty_type ?? "";
    const half = (a.session ?? "").toLowerCase();

    if (NON_WORKING_ONCALL.has(duty)) {
      onCallDates[dow].add(a.session_date);
      totalOnCall += 1;
      if (CONSULTANT_ONCALL_ICU_DUTIES.has(duty)) anyIcuOnCall = true;
      if (CONSULTANT_ONCALL_THEATRE_DUTIES.has(duty)) anyTheatreOnCall = true;
      continue;
    }

    // Any non-on-call duty counts as a "normal working" session for the
    // purposes of identifying which weekdays the consultant is normally
    // in the department (theatre, SPA, admin, teaching …).
    workingDates[dow].add(a.session_date);
    totalWorking += 1;
    if (half === "am") amWorkingDates[dow].add(a.session_date);
    else if (half === "pm") pmWorkingDates[dow].add(a.session_date);

    if (duty === "spa") {
      if (half === "am") spaAmDates[dow].add(a.session_date);
      else if (half === "pm") spaPmDates[dow].add(a.session_date);
    }

    if (duty === "theatre" && a.theatre_session_id) {
      const s = sessionsById.get(a.theatre_session_id);
      if (s && s.theatre_id) {
        const t = theatresById.get(s.theatre_id);
        if (t?.kind === "private" && !s.is_non_sag) {
          privateDates[dow].add(a.session_date);
        }
      }
    }
  }

  const pickRegular = (dates: Array<Set<string>>) =>
    [1, 2, 3, 4, 5].filter((d) => dates[d].size >= threshold);
  // SPA is often once-a-week or once-a-fortnight, so use a slightly
  // gentler threshold so a weekly SPA slot isn't lost to noise.
  const spaThreshold = Math.max(2, Math.floor(threshold / 2) + 1);
  const pickRegularSpa = (dates: Array<Set<string>>) =>
    [1, 2, 3, 4, 5].filter((d) => dates[d].size >= spaThreshold);

  const onCallType: ConsultantPattern["onCallType"] =
    anyTheatreOnCall && anyIcuOnCall
      ? "both"
      : anyIcuOnCall
        ? "icu"
        : anyTheatreOnCall
          ? "theatre"
          : "none";

  return {
    workingWeekdays: pickRegular(workingDates),
    privateWeekdays: pickRegular(privateDates),
    onCallWeekdays: pickRegular(onCallDates),
    onCallType,
    amWorkingWeekdays: pickRegular(amWorkingDates),
    pmWorkingWeekdays: pickRegular(pmWorkingDates),
    spaAmWeekdays: pickRegularSpa(spaAmDates),
    spaPmWeekdays: pickRegularSpa(spaPmDates),
    totalWorkingSessions: totalWorking,
    totalOnCallSessions: totalOnCall,
    regularityThreshold: threshold,
  };
}

/**
 * Suggested regularity threshold given a window in days. Roughly one
 * session per four weeks.
 */
export function suggestedRegularityThreshold(windowDays: number): number {
  return Math.max(2, Math.round(windowDays / 28));
}

export interface StaffLite {
  id: string;
  full_name: string;
  grade: StaffGrade | null;
}

/**
 * Fold the raw rota data into one `StaffSummary` per staff member.
 * Empty summaries are still produced for staff who have zero assignments
 * in the window, so the UI can surface them explicitly.
 */
export function summariseStaff(
  staff: StaffLite[],
  assignments: AssignmentLite[],
  sessionsById: Map<string, SessionLite>,
  theatresById: Map<string, TheatreLite>,
  specialtiesById: Map<string, SpecialtyLite>,
  opts: { regularityThreshold?: number } = {},
): StaffSummary[] {
  const byStaff = new Map<string, AssignmentLite[]>();
  for (const s of staff) byStaff.set(s.id, []);
  for (const a of assignments) {
    const bucket = byStaff.get(a.staff_id);
    if (bucket) bucket.push(a);
  }

  return staff.map((person): StaffSummary => {
    const own = byStaff.get(person.id) ?? [];
    const byLocation: Record<LocationBucket, number> = {
      main: 0,
      day_surgery: 0,
      private_sag: 0,
      private_non_sag: 0,
      obstetrics: 0,
      icu: 0,
      leave: 0,
      other: 0,
    };

    const specialtyCounts = new Map<string, number>();

    for (const a of own) {
      const session = a.theatre_session_id
        ? (sessionsById.get(a.theatre_session_id) ?? null)
        : null;
      const bucket = classifyLocation(a, session, theatresById);
      byLocation[bucket] += 1;

      if (a.duty_type === "theatre" && session?.specialty_id) {
        const spec = specialtiesById.get(session.specialty_id);
        if (spec) {
          specialtyCounts.set(spec.name, (specialtyCounts.get(spec.name) ?? 0) + 1);
        }
      }
    }

    const bySpecialty = Array.from(specialtyCounts.entries())
      .map(([specialty, count]) => ({ specialty, count }))
      .sort((a, b) => b.count - a.count || a.specialty.localeCompare(b.specialty));

    return {
      staff_id: person.id,
      full_name: person.full_name,
      grade: person.grade,
      totalSessions: own.length,
      byLocation,
      bySpecialty,
      consultantPattern:
        person.grade === "consultant"
          ? computeConsultantPattern(own, sessionsById, theatresById, opts)
          : null,
    };
  });
}

export interface DominantCell {
  bucket: LocationBucket;
  count: number;
  total: number;
}

/**
 * For each (weekday, half-session) pair, find the location bucket the
 * staff member is most often assigned to. Only pairs with at least
 * `minCount` distinct dates make the cut so a single one-off shift
 * doesn't dominate an otherwise-empty half.
 */
export function dominantByHalfSession(
  assignments: AssignmentLite[],
  sessionsById: Map<string, SessionLite>,
  theatresById: Map<string, TheatreLite>,
  minCount: number,
): Record<"am" | "pm", Array<DominantCell | null>> {
  const halves: Array<"am" | "pm"> = ["am", "pm"];
  const buckets: Record<"am" | "pm", Array<Map<LocationBucket, Set<string>>>> = {
    am: Array.from({ length: 7 }, () => new Map()),
    pm: Array.from({ length: 7 }, () => new Map()),
  };

  for (const a of assignments) {
    const d = new Date(`${a.session_date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getUTCDay();
    const half = (a.session ?? "").toLowerCase() as "am" | "pm" | "";
    if (half !== "am" && half !== "pm") continue;
    const session = a.theatre_session_id
      ? (sessionsById.get(a.theatre_session_id) ?? null)
      : null;
    const bucket = classifyLocation(a, session, theatresById);

    const map = buckets[half][dow];
    if (!map.has(bucket)) map.set(bucket, new Set());
    map.get(bucket)!.add(a.session_date);
  }

  const result: Record<"am" | "pm", Array<DominantCell | null>> = {
    am: Array.from({ length: 7 }, () => null),
    pm: Array.from({ length: 7 }, () => null),
  };
  for (const half of halves) {
    for (let dow = 1; dow <= 5; dow++) {
      const map = buckets[half][dow];
      let best: DominantCell | null = null;
      let total = 0;
      for (const [bucket, dates] of map.entries()) {
        total += dates.size;
        if (!best || dates.size > best.count) {
          best = { bucket, count: dates.size, total: 0 };
        }
      }
      if (best && best.count >= minCount) {
        best.total = total;
        result[half][dow] = best;
      }
    }
  }
  return result;
}

