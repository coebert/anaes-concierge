import { compareBySurname } from "@/lib/name-sort";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchAllRowsPaged,
  idKey,
  rotaAssignmentKey,
  type PaginateOptions,
} from "./paginate";

/**
 * Supabase silently caps a `.select()` at 1000 rows. For a multi-month
 * robustness window, `rota_assignments` and `theatre_sessions` routinely
 * exceed that and the audit ends up reasoning over a truncated slice
 * (producing false shortfalls / phantom unfilled lists). Paginate every
 * read used by this module through the shared helper, which also dedupes
 * across page boundaries.
 */
function fetchAllRows<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  opts: PaginateOptions<T> = {},
): Promise<T[]> {
  return fetchAllRowsPaged<T>(build, opts);
}

/**
 * Emergency / CEPOD theatre sessions are not regular planned lists — they
 * are covered by the on-call rota, not by allocating a free consultant
 * from the daytime pool. Counting them as `required` lists inflates demand
 * (and would mark the on-call consultant as "covering a list", removing
 * them from the pool twice). Detected via the linked specialty name or a
 * free-text surgical_consultant hint, consistent with list-feasibility.
 */
function isEmergencyTheatreSession(
  t: { specialty_id?: string | null; surgical_consultant?: string | null },
  emergencySpecialtyIds: Set<string>,
): boolean {
  if (t.specialty_id && emergencySpecialtyIds.has(t.specialty_id)) return true;
  const sc = (t.surgical_consultant ?? "").toLowerCase();
  return /emergenc|cepod/.test(sc);
}

export type Grade = "consultant" | "sas" | "trainee" | "unknown";
export type SessionHalf = "am" | "pm";

export interface ExtraAbsence {
  staffId?: string;
  grade?: Grade; // when set without staffId, counts as N absences in that grade
  count?: number;
}

export interface HalfDayCapacity {
  required: number;
  /** Solo-capable staff free to deploy (consultant or ST6/ST7/ST8). */
  soloCapable: number;
  /** Consultants free to deploy — NOT on leave, on excluded duties, on SPA, or already covering a list. */
  consultantsAvailable: number;
  /** ST6/ST7/ST8 trainees free to deploy — solo-capable. */
  seniorTraineesAvailable: number;
  /** Junior trainees free to deploy — supervised only, do not count toward solo cover. */
  juniorTraineesAvailable: number;
  /** SAS doctors free to deploy — tracked but do not count toward solo cover. */
  sasAvailable: number;
  /** Consultants on SPA time — flexible cover (counted only in `headroomWithSpa`). */
  consultantsOnSpa: number;
  onLeave: number;
  onOtherDuty: number; // on-call, ICU, obstetrics, teaching, non-clinical, admin, CIC
  headroom: number; // soloCapable - unfilled (SPA NOT counted)
  headroomWithSpa: number; // (soloCapable + consultantsOnSpa) - unfilled
  risk: "ok" | "tight" | "shortfall" | "spa_required";
  unfilled: number;
}

export interface DayCapacity {
  date: string;
  dow: number;
  am: HalfDayCapacity;
  pm: HalfDayCapacity;
}

const RISK_TIGHT = 1;

function eachWeekday(start: string, end: string): string[] {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const out: string[] = [];
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** ST6 / ST7 trainees can solo-cover daytime lists. */
export function isSeniorTrainee(trainingLevel: string | null | undefined): boolean {
  if (!trainingLevel) return false;
  const t = trainingLevel.trim().toUpperCase();
  return t === "ST6" || t === "ST7" || t === "ST8";
}

/**
 * Built-in fallback classification used only if the `duty_type_pool_rules`
 * settings table is empty or unreachable. Admins can override every entry
 * via /admin/duty-categories.
 */
const DEFAULT_UNAVAILABLE_DUTY_TYPES = new Set<string>([
  "icu_consultant_oncall",
  "general_consultant_oncall",
  "registrar_oncall",
  "sho_oncall",
  "icu_trainee",
  "icu_ct2_plus",
  "obstetrics",
  "obstetrics_2nd",
  "consultant_in_charge",
  "teaching",
  "non_clinical",
  "admin",
]);
const DEFAULT_FLEX_DUTY_TYPES = new Set<string>(["spa"]);
const DEFAULT_CLINICAL_LIST_DUTY_TYPES = new Set<string>(["theatre"]);

export interface DutyPoolSets {
  /** Duty types treated as "covering a clinical list" — excluded from pool. */
  clinicalList: Set<string>;
  /** Duty types treated as unavailable all day. */
  unavailable: Set<string>;
  /** Duty types treated as flexible cover (SPA-style). */
  flex: Set<string>;
}

async function loadDutyPoolSets(): Promise<DutyPoolSets> {
  const { data } = await supabase
    .from("duty_type_pool_rules")
    .select("duty_type, category");
  const rows = (data ?? []) as Array<{ duty_type: string; category: string }>;
  if (rows.length === 0) {
    return {
      clinicalList: new Set(DEFAULT_CLINICAL_LIST_DUTY_TYPES),
      unavailable: new Set(DEFAULT_UNAVAILABLE_DUTY_TYPES),
      flex: new Set(DEFAULT_FLEX_DUTY_TYPES),
    };
  }
  const sets: DutyPoolSets = {
    clinicalList: new Set(),
    unavailable: new Set(),
    flex: new Set(),
  };
  for (const r of rows) {
    if (r.category === "clinical_list") sets.clinicalList.add(r.duty_type);
    else if (r.category === "excluded") sets.unavailable.add(r.duty_type);
    else if (r.category === "flex") sets.flex.add(r.duty_type);
  }
  return sets;
}


/**
 * Pure risk classifier. Exported for unit testing.
 *
 * - shortfall: not enough solo-capable staff even after redeploying SPA
 * - spa_required: shortfall closes only by pulling a consultant off SPA
 * - tight: covered but headroom is at or below RISK_TIGHT
 * - ok: comfortable headroom
 */
export function classifyRisk(
  headroom: number,
  headroomWithSpa: number,
): HalfDayCapacity["risk"] {
  if (headroom < 0 && headroomWithSpa >= 0) return "spa_required";
  if (headroom < 0) return "shortfall";
  if (headroom <= RISK_TIGHT) return "tight";
  return "ok";
}

// Backwards-compatible internal alias.
const classify = classifyRisk;

/**
 * Inputs for the pure half-day capacity calculation. Exported so the
 * derivation of soloCapable / headroom / headroomWithSpa / risk can be
 * unit-tested independently of the database.
 */
export interface HalfDayInputs {
  required: number;
  consultantsAvailable: number;
  seniorTraineesAvailable: number;
  juniorTraineesAvailable: number;
  sasAvailable: number;
  consultantsOnSpa: number;
  onLeave: number;
  onOtherDuty: number;
  unfilled?: number;
}

/**
 * Pure derivation of a HalfDayCapacity from the available staff buckets.
 *
 * Available buckets (`consultantsAvailable`, `seniorTraineesAvailable`,
 * `juniorTraineesAvailable`, `sasAvailable`) are people who are NOT on
 * leave, NOT on an excluded duty (ICU, obstetrics, on-call, teaching,
 * admin, CIC), and NOT already covering a clinical list (theatre / POAC
 * / pain clinic / any other theatre_session). They are truly free.
 *
 * `consultantsOnSpa` are consultants on SPA time — flexible cover only,
 * counted in `headroomWithSpa` but not in baseline `headroom`.
 *
 * `soloCapable` = free consultants + free senior trainees (ST6/ST7/ST8).
 * SAS and junior trainees are tracked but NOT counted toward solo cover.
 *
 * `headroom` = `soloCapable - unfilled` (lists still needing cover).
 * When `unfilled` is omitted it falls back to `required` for legacy
 * call sites in the tests.
 */
export function computeHalfDayCapacity(i: HalfDayInputs): HalfDayCapacity {
  const soloCapable = i.consultantsAvailable + i.seniorTraineesAvailable;
  const unfilled = Math.max(0, i.unfilled ?? i.required);
  const headroom = soloCapable - unfilled;
  const headroomWithSpa = soloCapable + i.consultantsOnSpa - unfilled;
  return {
    required: i.required,
    soloCapable,
    consultantsAvailable: i.consultantsAvailable,
    seniorTraineesAvailable: i.seniorTraineesAvailable,
    juniorTraineesAvailable: i.juniorTraineesAvailable,
    sasAvailable: i.sasAvailable,
    consultantsOnSpa: i.consultantsOnSpa,
    onLeave: i.onLeave,
    onOtherDuty: i.onOtherDuty,
    headroom,
    headroomWithSpa,
    risk: classifyRisk(headroom, headroomWithSpa),
    unfilled,
  };
}


export interface RobustnessOptions {
  /**
   * When true (default), staff are only counted toward availability if they
   * have at least one rota_assignment that day — evidence they are actually
   * rostered to work. CLWRota seeds a row for every working slot, so absence
   * of any row means the person is simply not on duty (rolling rota day off,
   * between rotations, etc.). Without this gate, every consultant who had no
   * entry on a date was wrongly counted as a free consultant.
   */
  requireRosterEvidence?: boolean;
}

export async function computeRobustness(
  rangeStart: string,
  rangeEnd: string,
  extraAbsences: ExtraAbsence[] = [],
  options: RobustnessOptions = {},
): Promise<{ days: DayCapacity[]; totalStaffByGrade: Record<Grade, number> }> {
  const requireRosterEvidence = options.requireRosterEvidence ?? true;
  const poolSets = await loadDutyPoolSets();


  const [profiles, leave, theatreSessionsRaw, assignments, specialtiesAll] =
    await Promise.all([
      fetchAllRows<{
        id: string;
        grade: string | null;
        training_level: string | null;
        ltft_days_off: number[] | null;
      }>((from, to) =>
        supabase
          .from("profiles")
          .select("id, grade, training_level, ltft_days_off")
          .eq("active", true)
          .order("id", { ascending: true })
          .range(from, to),
        { rowKey: idKey, label: "robustness.profiles" },
      ),
      fetchAllRows<{
        staff_id: string;
        start_date: string;
        end_date: string;
        status: string;
      }>((from, to) =>
        supabase
          .from("leave_requests")
          .select("staff_id, start_date, end_date, status")
          .eq("status", "approved")
          .lte("start_date", rangeEnd)
          .gte("end_date", rangeStart)
          .order("staff_id", { ascending: true })
          .order("start_date", { ascending: true })
          .order("end_date", { ascending: true })
          .range(from, to),
        {
          rowKey: (r) => `${r.staff_id}|${r.start_date}|${r.end_date}`,
          label: "robustness.leave_requests",
        },
      ),
      fetchAllRows<{
        id: string;
        session_date: string;
        session: string;
        specialty_id: string | null;
        surgical_consultant: string | null;
        theatre_id: string | null;
      }>((from, to) =>
        supabase
          .from("theatre_sessions")
          .select("id, session_date, session, specialty_id, surgical_consultant, theatre_id")
          .gte("session_date", rangeStart)
          .lte("session_date", rangeEnd)
          .order("id", { ascending: true })
          .range(from, to),
        { rowKey: idKey, label: "robustness.theatre_sessions" },
      ),
      fetchAllRows<{
        staff_id: string;
        session_date: string;
        session: string;
        duty_type: string;
        theatre_session_id: string | null;
      }>((from, to) =>
        supabase
          .from("rota_assignments")
          .select(
            "staff_id, session_date, session, duty_type, theatre_session_id",
          )
          .gte("session_date", rangeStart)
          .lte("session_date", rangeEnd)
          .order("session_date", { ascending: true })
          .order("staff_id", { ascending: true })
          .order("session", { ascending: true })
          .range(from, to),
        { rowKey: rotaAssignmentKey, label: "robustness.rota_assignments" },
      ),
      fetchAllRows<{ id: string; name: string }>((from, to) =>
        supabase
          .from("specialties")
          .select("id, name")
          .order("id", { ascending: true })
          .range(from, to),
        { rowKey: idKey, label: "robustness.specialties" },
      ),
    ]);

  // Theatres marked inactive (e.g. "NHH (legacy)") may still have stale
  // theatre_sessions rows from earlier syncs. Those phantom lists inflate
  // the "required" count and surface as a false consultant shortfall even
  // though every real theatre is fully staffed. Drop them up-front so they
  // don't contribute to demand or coverage.
  const { data: inactiveTheatreRows } = await supabase
    .from("theatres")
    .select("id")
    .eq("active", false);
  const inactiveTheatreIds = new Set(
    (inactiveTheatreRows ?? []).map((t) => t.id as string),
  );


  const emergencySpecialtyIds = new Set(
    specialtiesAll
      .filter((s) => /emergenc|cepod/i.test(s.name ?? ""))
      .map((s) => s.id),
  );

  // Drop emergency / CEPOD sessions from the planned-list demand model,
  // and drop sessions attached to inactive theatres (stale rows from old
  // syncs would otherwise look like an unfilled list).
  const theatreSessions = theatreSessionsRaw.filter(
    (t) =>
      !isEmergencyTheatreSession(t, emergencySpecialtyIds) &&
      !(t.theatre_id && inactiveTheatreIds.has(t.theatre_id)),
  );
  const emergencySessionIds = new Set(
    theatreSessionsRaw
      .filter((t) => isEmergencyTheatreSession(t, emergencySpecialtyIds))
      .map((t) => t.id),
  );

  const staff = profiles;


  const totalStaffByGrade: Record<Grade, number> = {
    consultant: 0, sas: 0, trainee: 0, unknown: 0,
  };
  for (const s of staff) {
    const g = (s.grade as Grade) ?? "unknown";
    totalStaffByGrade[g] = (totalStaffByGrade[g] ?? 0) + 1;
  }

  // staff_id -> set of dates on approved leave
  const leaveByDate = new Map<string, Set<string>>();
  for (const l of leave) {
    const from = new Date((l.start_date < rangeStart ? rangeStart : l.start_date) + "T00:00:00Z");
    const to = new Date((l.end_date > rangeEnd ? rangeEnd : l.end_date) + "T00:00:00Z");
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const set = leaveByDate.get(iso) ?? new Set();
      set.add(l.staff_id);
      leaveByDate.set(iso, set);
    }
  }

  // theatre lists requiring cover per date (emergency / CEPOD already removed)
  const requiredMap = new Map<string, { am: number; pm: number }>();
  for (const t of theatreSessions) {
    const r = requiredMap.get(t.session_date) ?? { am: 0, pm: 0 };
    if (t.session === "am") r.am += 1;
    if (t.session === "pm") r.pm += 1;
    requiredMap.set(t.session_date, r);
  }

  // assignments indexed by (date, session) and (date, staff)
  type AsnState = "theatre" | "spa" | "unavailable";
  const staffStateByDateSession = new Map<string, Map<string, AsnState>>();
  // also track any-session unavailability (e.g. on-call spanning the day)
  const dailyUnavailable = new Map<string, Set<string>>();
  const dailySpa = new Map<string, Set<string>>();
  const filledMap = new Map<string, { am: Set<string>; pm: Set<string> }>();
  // Staff with ANY assignment that day — evidence they are rostered to work.
  // CLWRota inserts a row for every working slot (theatre, SPA, admin, ICU,
  // on-call, teaching, obstetrics, etc.) so absence of any row means the
  // person simply isn't scheduled. Without this gate, every consultant on a
  // non-working day was counted as "available" and inflated headroom.
  const workingToday = new Map<string, Set<string>>();


  for (const a of assignments) {
    const date = a.session_date;
    const sess = a.session; // am/pm/eve/night
    const sid = a.staff_id;
    const dt = a.duty_type;

    // Emergency / CEPOD theatre assignments are part of the on-call rota,
    // not the planned-list pool: don't count them as filling a regular list
    // and don't remove the consultant from the daytime pool here.
    if (a.theatre_session_id && emergencySessionIds.has(a.theatre_session_id)) {
      continue;
    }

    // Any non-emergency assignment is evidence this person is at work today.
    const wt = workingToday.get(date) ?? new Set<string>();
    wt.add(sid);
    workingToday.set(date, wt);

    if (dt === "theatre" && a.theatre_session_id && (sess === "am" || sess === "pm")) {
      const cur = filledMap.get(date) ?? { am: new Set<string>(), pm: new Set<string>() };
      (sess === "am" ? cur.am : cur.pm).add(a.theatre_session_id);
      filledMap.set(date, cur);

    }


    // Anyone on a configured clinical-list duty (e.g. theatre, POAC, pain
    // clinic, future activities) for a specific half-day is removed from
    // that half's pool.
    const isClinicalList = poolSets.clinicalList.has(dt);

    if (isClinicalList && a.theatre_session_id && (sess === "am" || sess === "pm")) {
      const cur = filledMap.get(date) ?? { am: new Set<string>(), pm: new Set<string>() };
      (sess === "am" ? cur.am : cur.pm).add(a.theatre_session_id as string);
      filledMap.set(date, cur);
    }

    if (poolSets.unavailable.has(dt)) {
      const set = dailyUnavailable.get(date) ?? new Set<string>();
      set.add(sid);
      dailyUnavailable.set(date, set);
    } else if (poolSets.flex.has(dt)) {
      const key = `${date}|${sess}`;
      const sm = staffStateByDateSession.get(key) ?? new Map<string, AsnState>();
      // SPA-style flex only flags the specific half-day it covers
      if (sess === "am" || sess === "pm") {
        sm.set(sid, "spa");
        staffStateByDateSession.set(key, sm);
        const set = dailySpa.get(`${date}|${sess}`) ?? new Set<string>();
        set.add(sid);
        dailySpa.set(`${date}|${sess}`, set);
      }
    } else if (isClinicalList && (sess === "am" || sess === "pm")) {
      const key = `${date}|${sess}`;
      const sm = staffStateByDateSession.get(key) ?? new Map<string, AsnState>();
      sm.set(sid, "theatre");
      staffStateByDateSession.set(key, sm);
    }
  }

  // Hypothetical absences
  const extraStaffOff = new Set<string>();
  const extraByGrade: Record<Grade, number> = {
    consultant: 0, sas: 0, trainee: 0, unknown: 0,
  };
  for (const x of extraAbsences) {
    if (x.staffId) extraStaffOff.add(x.staffId);
    else if (x.grade) extraByGrade[x.grade] = (extraByGrade[x.grade] ?? 0) + (x.count ?? 1);
  }

  const days: DayCapacity[] = [];
  for (const date of eachWeekday(rangeStart, rangeEnd)) {
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const offToday = leaveByDate.get(date) ?? new Set<string>();
    const otherDutyToday = dailyUnavailable.get(date) ?? new Set<string>();
    const rosteredToday = workingToday.get(date) ?? new Set<string>();

    const mkHalf = (req: number, half: SessionHalf): HalfDayCapacity => {
      const halfKey = `${date}|${half}`;
      const spaThisHalf = dailySpa.get(halfKey) ?? new Set<string>();
      const stateThisHalf = staffStateByDateSession.get(halfKey) ?? new Map<string, AsnState>();
      let consultants = 0, seniorTrainees = 0, juniorTrainees = 0, sas = 0;
      let consultantsOnSpa = 0;
      const extraRemainingByGrade: Record<Grade, number> = { ...extraByGrade };

      for (const s of staff) {
        if (offToday.has(s.id)) continue;
        if (extraStaffOff.has(s.id)) continue;
        if ((s.ltft_days_off ?? []).includes(dow)) continue;
        if (otherDutyToday.has(s.id)) continue;
        // Only count staff who have evidence of being rostered to work today.
        // CLWRota records a row for every working slot, so no rows = not on
        // duty (e.g. day off in a rolling rota, between rotations, etc.).
        if (requireRosterEvidence && !rosteredToday.has(s.id)) continue;



        const grade = (s.grade as Grade) ?? "unknown";
        const isSpa = spaThisHalf.has(s.id);
        // Anyone already on a clinical list this half-day (theatre/POAC/
        // pain clinic — any theatre_session) is NOT free to redeploy.
        const onClinicalList = stateThisHalf.get(s.id) === "theatre";

        if (grade === "consultant") {
          if (isSpa) consultantsOnSpa += 1;
          else if (!onClinicalList) consultants += 1;
        } else if (grade === "sas") {
          if (!onClinicalList) sas += 1;
        } else if (grade === "trainee") {
          if (onClinicalList) continue;
          if (isSeniorTrainee(s.training_level)) seniorTrainees += 1;
          else juniorTrainees += 1;
        }
      }

      // Apply hypothetical by-grade absences (subtract from the pool).
      const sub = (n: number, k: number) => Math.max(0, n - k);
      consultants = sub(consultants, extraRemainingByGrade.consultant);
      sas = sub(sas, extraRemainingByGrade.sas);
      // Take from juniors first, then seniors.
      const traineeKnockdown = extraRemainingByGrade.trainee;
      const fromJuniors = Math.min(juniorTrainees, traineeKnockdown);
      juniorTrainees -= fromJuniors;
      seniorTrainees = sub(seniorTrainees, traineeKnockdown - fromJuniors);

      const onLeaveCount = offToday.size + extraStaffOff.size
        + Object.values(extraByGrade).reduce((a, b) => a + b, 0);

      const filledCount = filledMap.get(date)?.[half]?.size ?? 0;
      const unfilled = Math.max(0, req - filledCount);

      return computeHalfDayCapacity({
        required: req,
        consultantsAvailable: consultants,
        seniorTraineesAvailable: seniorTrainees,
        juniorTraineesAvailable: juniorTrainees,
        sasAvailable: sas,
        consultantsOnSpa,
        onLeave: onLeaveCount,
        onOtherDuty: otherDutyToday.size,
        unfilled,
      });

    };

    const required = requiredMap.get(date) ?? { am: 0, pm: 0 };
    days.push({
      date,
      dow,
      am: mkHalf(required.am, "am"),
      pm: mkHalf(required.pm, "pm"),
    });
  }

  return { days, totalStaffByGrade };
}

/* --------------------------------------------------------------------------
 * Per-list coverage breakdown (solo-capable vs supervised vs unfilled)
 * ----------------------------------------------------------------------- */

export interface HalfDayListCoverage {
  total: number;
  /** Lists with at least one consultant or senior trainee assigned. */
  soloCapable: number;
  /** Filled lists with only junior trainees / SAS (no solo-capable staff). */
  supervised: number;
  /** Lists with no assignments at all. */
  unfilled: number;
  /** Whether the half-day is classified as spa_required. */
  spaNeeded: boolean;
}

export interface DayListCoverage {
  date: string;
  dow: number;
  am: HalfDayListCoverage;
  pm: HalfDayListCoverage;
}

export async function computeListCoverage(
  rangeStart: string,
  rangeEnd: string,
  options: RobustnessOptions = {},
): Promise<DayListCoverage[]> {

  const [sessionsRaw, specialtiesAll] = await Promise.all([
    fetchAllRows<{
      id: string;
      session_date: string;
      session: string;
      specialty_id: string | null;
      surgical_consultant: string | null;
    }>((from, to) =>
      supabase
        .from("theatre_sessions")
        .select("id, session_date, session, specialty_id, surgical_consultant")
        .gte("session_date", rangeStart)
        .lte("session_date", rangeEnd)
        .order("id", { ascending: true })
        .range(from, to),
      { rowKey: idKey, label: "list-coverage.theatre_sessions" },
    ),
    fetchAllRows<{ id: string; name: string }>((from, to) =>
      supabase
        .from("specialties")
        .select("id, name")
        .order("id", { ascending: true })
        .range(from, to),
      { rowKey: idKey, label: "list-coverage.specialties" },
    ),
  ]);


  const emergencySpecialtyIds = new Set(
    specialtiesAll
      .filter((s) => /emergenc|cepod/i.test(s.name ?? ""))
      .map((s) => s.id),
  );
  const sessions = sessionsRaw.filter(
    (t) => !isEmergencyTheatreSession(t, emergencySpecialtyIds),
  );

  const tsIds = sessions.map((s) => s.id);

  let asns: Array<{
    theatre_session_id: string;
    session_date: string;
    session: string;
    profiles: { grade: string | null; training_level: string | null };
  }> = [];

  if (tsIds.length > 0) {
    // `.in()` URL-encoded list is bounded by URL length; chunk to be safe.
    const CHUNK = 200;
    for (let i = 0; i < tsIds.length; i += CHUNK) {
      const slice = tsIds.slice(i, i + CHUNK);
      const rows = await fetchAllRows<(typeof asns)[number]>(
        (from, to) =>
          supabase
            .from("rota_assignments")
            .select(
              `theatre_session_id, session_date, session, profiles!rota_assignments_staff_id_fkey!inner(grade, training_level)`,
            )
            .in("theatre_session_id", slice)
            .eq("duty_type", "theatre")
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: (typeof asns)[number][] | null;
            error: unknown;
          }>,
      );
      asns.push(...rows);
    }

  }


  // Map theatre_session_id -> set of assigned staff grades/levels
  const coverageBySession = new Map<
    string,
    { hasSolo: boolean; hasSupervised: boolean }
  >();
  for (const a of asns) {
    const tsId = a.theatre_session_id;
    const cur = coverageBySession.get(tsId) ?? {
      hasSolo: false,
      hasSupervised: false,
    };
    const grade = a.profiles.grade;
    const level = a.profiles.training_level;
    if (grade === "consultant" || (grade === "trainee" && isSeniorTrainee(level))) {
      cur.hasSolo = true;
    } else if (grade === "trainee" || grade === "sas") {
      cur.hasSupervised = true;
    }
    coverageBySession.set(tsId, cur);
  }

  // Also need SPA-needed flags from robustness
  const { days } = await computeRobustness(rangeStart, rangeEnd, [], options);

  // Build per-date required totals
  const requiredMap = new Map<string, { am: number; pm: number }>();
  for (const s of sessions ?? []) {
    const r = requiredMap.get(s.session_date as string) ?? { am: 0, pm: 0 };
    const half = s.session as string;
    if (half === "am") r.am += 1;
    if (half === "pm") r.pm += 1;
    requiredMap.set(s.session_date as string, r);
  }

  // Group sessions by date + session
  const sessionIdsByHalf = new Map<string, Set<string>>();
  for (const s of sessions ?? []) {
    const key = `${s.session_date as string}|${s.session as string}`;
    const set = sessionIdsByHalf.get(key) ?? new Set<string>();
    set.add(s.id as string);
    sessionIdsByHalf.set(key, set);
  }

  const out: DayListCoverage[] = [];
  for (const date of eachWeekday(rangeStart, rangeEnd)) {
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const dayRobust = days.find((d) => d.date === date);

    const mkHalf = (half: SessionHalf): HalfDayListCoverage => {
      const halfKey = `${date}|${half}`;
      const tsIdsInHalf = sessionIdsByHalf.get(halfKey) ?? new Set<string>();
      let soloCapable = 0;
      let supervised = 0;
      let unfilled = 0;
      for (const tsId of tsIdsInHalf) {
        const cov = coverageBySession.get(tsId);
        if (cov?.hasSolo) soloCapable += 1;
        else if (cov?.hasSupervised) supervised += 1;
        else unfilled += 1;
      }
      return {
        total: tsIdsInHalf.size,
        soloCapable,
        supervised,
        unfilled,
        spaNeeded: dayRobust?.[half].risk === "spa_required",
      };
    };

    out.push({
      date,
      dow,
      am: mkHalf("am"),
      pm: mkHalf("pm"),
    });
  }

  return out;
}

export function riskColor(risk: HalfDayCapacity["risk"]): string {
  if (risk === "shortfall") return "bg-red-500/80 text-white";
  if (risk === "spa_required") return "bg-orange-400/80 text-white";
  if (risk === "tight") return "bg-amber-400/80";
  return "bg-emerald-300/50";
}

export function riskLabel(risk: HalfDayCapacity["risk"]): string {
  if (risk === "shortfall") return "Shortfall";
  if (risk === "spa_required") return "SPA needed";
  if (risk === "tight") return "Tight";
  return "OK";
}

// ============= Per-day drilldown =============

export interface DayDetailSession {
  id: string;
  session: SessionHalf;
  theatreName: string;
  specialty: string | null;
  surgicalConsultant: string | null;
  assignments: Array<{
    staffName: string;
    role: string;
    grade: Grade;
    trainingLevel: string | null;
  }>;
  unfilled: boolean;
}

export interface PersonRef {
  staffId: string;
  staffName: string;
  grade: Grade;
  trainingLevel: string | null;
}

export interface LeaveDetail extends PersonRef {
  type: string;
  status: string;
}

export interface OtherDutyDetail extends PersonRef {
  duty: string;
  session: string;
}

/** Per-half-day classification of every active staff member. */
export type StaffStatusCategory =
  | "free_consultant"
  | "free_senior_trainee"
  | "free_junior_trainee"
  | "free_sas"
  | "on_spa"
  | "on_clinical_list"
  | "on_excluded_duty"
  | "on_leave"
  | "ltft_off";

export interface StaffStatusEntry extends PersonRef {
  category: StaffStatusCategory;
  /** Human-readable reason, e.g. "Covering Theatre 3 (Orthopaedics)", "ICU consultant on-call", "Annual leave". */
  reason: string;
  /** Whether this person counts toward soloCapable for the half-day. */
  countsToSolo: boolean;
  /** For trainees: whether this half-day advances a documented subspecialty / solo / supervised training target. */
  trainingNote?: {
    tone: "good" | "neutral" | "miss";
    label: string;
    /** Detailed tooltip — target context, role, what counts. */
    detail: string;
  };
}

export interface HalfBreakdown {
  session: SessionHalf;
  entries: StaffStatusEntry[];
}

export interface DayDetail {
  date: string;
  dow: number;
  sessions: DayDetailSession[];
  onLeave: LeaveDetail[];
  ltftOff: PersonRef[];
  onOtherDuty: OtherDutyDetail[];
  consultantsOnSpa: { am: OtherDutyDetail[]; pm: OtherDutyDetail[] };
  am: HalfDayCapacity;
  pm: HalfDayCapacity;
  amBreakdown: HalfBreakdown;
  pmBreakdown: HalfBreakdown;
}


export async function loadDayDetail(date: string): Promise<DayDetail> {
  const { days } = await computeRobustness(date, date);
  const day = days[0];

  const poolSets = await loadDutyPoolSets();

  const [
    { data: theatreSessions },
    { data: profiles },
    { data: leave },
    { data: assignments },
    { data: traineeTargets },
  ] = await Promise.all([
    supabase
      .from("theatre_sessions")
      .select("id, session, theatre_id, specialty_id, surgical_consultant")
      .eq("session_date", date),
    supabase
      .from("profiles")
      .select("id, full_name, grade, training_level, ltft_days_off, active")
      .eq("active", true),
    supabase
      .from("leave_requests")
      .select("staff_id, type, status")
      .eq("status", "approved")
      .lte("start_date", date)
      .gte("end_date", date),
    supabase
      .from("rota_assignments")
      .select("staff_id, theatre_session_id, role_on_list, duty_type, session")
      .eq("session_date", date),
    supabase
      .from("trainee_targets")
      .select("training_level, specialty_id, required_sessions, required_solo, required_supervised"),
  ]);

  const ts = theatreSessions ?? [];
  const theatreIds = [...new Set(ts.map((t) => t.theatre_id).filter(Boolean))] as string[];
  const specialtyIds = [...new Set(ts.map((t) => t.specialty_id).filter(Boolean))] as string[];

  const [{ data: theatres }, { data: specialties }] = await Promise.all([
    theatreIds.length
      ? supabase.from("theatres").select("id, name").in("id", theatreIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    specialtyIds.length
      ? supabase.from("specialties").select("id, name").in("id", specialtyIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
  ]);

  const theatreNameById = new Map((theatres ?? []).map((t) => [t.id, t.name]));
  const specialtyNameById = new Map((specialties ?? []).map((s) => [s.id, s.name]));

  const profById = new Map(
    (profiles ?? []).map((p) => [
      p.id as string,
      {
        full_name: p.full_name as string,
        grade: (p.grade as Grade) ?? "unknown",
        training_level: (p.training_level as string | null) ?? null,
        ltft_days_off: (p.ltft_days_off ?? []) as number[],
      },
    ]),
  );

  const mkRef = (id: string): PersonRef => {
    const p = profById.get(id);
    return {
      staffId: id,
      staffName: p?.full_name ?? "Unknown",
      grade: p?.grade ?? "unknown",
      trainingLevel: p?.training_level ?? null,
    };
  };

  const asnByTheatreSession = new Map<
    string,
    Array<{ staffName: string; role: string; grade: Grade; trainingLevel: string | null }>
  >();
  const otherDutyMap = new Map<string, OtherDutyDetail>(); // dedupe by staff
  const spa = { am: [] as OtherDutyDetail[], pm: [] as OtherDutyDetail[] };

  for (const a of assignments ?? []) {
    const sid = a.staff_id as string;
    const dt = a.duty_type as string;
    const sess = a.session as string;

    if (dt === "theatre" && a.theatre_session_id) {
      const prof = profById.get(sid);
      const arr = asnByTheatreSession.get(a.theatre_session_id as string) ?? [];
      arr.push({
        staffName: prof?.full_name ?? "Unknown",
        role: a.role_on_list as string,
        grade: prof?.grade ?? "unknown",
        trainingLevel: prof?.training_level ?? null,
      });
      asnByTheatreSession.set(a.theatre_session_id as string, arr);
    } else if (poolSets.unavailable.has(dt)) {
      otherDutyMap.set(sid + "|" + dt, { ...mkRef(sid), duty: dt, session: sess });
    } else if (poolSets.flex.has(dt) && (sess === "am" || sess === "pm")) {
      const ref = mkRef(sid);
      if ((profById.get(sid)?.grade ?? "unknown") === "consultant") {
        (sess === "am" ? spa.am : spa.pm).push({ ...ref, duty: dt, session: sess });
      }
    }
  }

  const sessions: DayDetailSession[] = ts.map((t) => {
    const asns = asnByTheatreSession.get(t.id as string) ?? [];
    return {
      id: t.id as string,
      session: t.session as SessionHalf,
      theatreName: theatreNameById.get(t.theatre_id as string) ?? "—",
      specialty: t.specialty_id ? specialtyNameById.get(t.specialty_id as string) ?? null : null,
      surgicalConsultant: (t.surgical_consultant as string | null) ?? null,
      assignments: asns,
      unfilled: asns.length === 0,
    };
  }).sort((a, b) =>
    a.session === b.session ? a.theatreName.localeCompare(b.theatreName) : a.session === "am" ? -1 : 1,
  );

  const onLeave: LeaveDetail[] = (leave ?? []).map((l) => ({
    ...mkRef(l.staff_id as string),
    type: l.type as string,
    status: l.status as string,
  })).sort((a, b) => compareBySurname(a.staffName, b.staffName));

  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  const ltftOff: PersonRef[] = [...profById.entries()]
    .filter(([, p]) => p.ltft_days_off.includes(dow))
    .map(([id]) => mkRef(id))
    .sort((a, b) => compareBySurname(a.staffName, b.staffName));

  const onOtherDuty = [...otherDutyMap.values()]
    .sort((a, b) => compareBySurname(a.staffName, b.staffName));

  const empty: HalfDayCapacity = {
    required: 0, soloCapable: 0, consultantsAvailable: 0, seniorTraineesAvailable: 0,
    juniorTraineesAvailable: 0, sasAvailable: 0, consultantsOnSpa: 0, onLeave: 0,
    onOtherDuty: 0, headroom: 0, headroomWithSpa: 0, risk: "ok", unfilled: 0,
  };

  // ----- Per-half-day per-staff breakdown -----
  const tsInfoById = new Map<
    string,
    { theatreName: string; specialty: string | null; specialtyId: string | null }
  >();
  for (const t of ts) {
    tsInfoById.set(t.id as string, {
      theatreName: theatreNameById.get(t.theatre_id as string) ?? "—",
      specialty: t.specialty_id ? specialtyNameById.get(t.specialty_id as string) ?? null : null,
      specialtyId: (t.specialty_id as string | null) ?? null,
    });
  }

  const leaveTypeByStaff = new Map<string, string>();
  for (const l of leave ?? []) {
    leaveTypeByStaff.set(l.staff_id as string, l.type as string);
  }

  type HalfAssn =
    | { kind: "theatre"; theatreSessionId: string; role: string | null }
    | { kind: "spa" }
    | undefined;
  const halfAssn: Record<SessionHalf, Map<string, HalfAssn>> = {
    am: new Map(),
    pm: new Map(),
  };
  const excludedAllDay = new Map<string, string>(); // staff -> duty
  for (const a of assignments ?? []) {
    const sid = a.staff_id as string;
    const dt = a.duty_type as string;
    const sess = a.session as string;
    if (poolSets.unavailable.has(dt)) {
      if (!excludedAllDay.has(sid)) excludedAllDay.set(sid, dt);
      continue;
    }
    if (sess !== "am" && sess !== "pm") continue;
    const half = sess as SessionHalf;
    if (poolSets.clinicalList.has(dt) && a.theatre_session_id) {
      halfAssn[half].set(sid, {
        kind: "theatre",
        theatreSessionId: a.theatre_session_id as string,
        role: (a.role_on_list as string | null) ?? null,
      });
    } else if (poolSets.flex.has(dt)) {
      if (!halfAssn[half].has(sid)) halfAssn[half].set(sid, { kind: "spa" });
    }
  }

  // Index trainee targets by training_level for quick lookup.
  type TargetRow = {
    training_level: string;
    specialty_id: string;
    required_sessions: number;
    required_solo: number;
    required_supervised: number;
  };
  const targetsByLevel = new Map<string, TargetRow[]>();
  for (const t of (traineeTargets ?? []) as TargetRow[]) {
    const lvl = (t.training_level ?? "").trim().toUpperCase();
    if (!lvl) continue;
    const arr = targetsByLevel.get(lvl) ?? [];
    arr.push(t);
    targetsByLevel.set(lvl, arr);
  }

  // Build trainingNote for a trainee in this half-day.
  const traineeNote = (
    ref: PersonRef,
    state:
      | { kind: "theatre"; specialtyId: string | null; specialtyName: string | null; role: string | null }
      | { kind: "free" }
      | { kind: "excluded"; reason: string },
  ): StaffStatusEntry["trainingNote"] => {
    if (ref.grade !== "trainee") return undefined;
    const lvl = (ref.trainingLevel ?? "").trim().toUpperCase();
    const targets = lvl ? targetsByLevel.get(lvl) ?? [] : [];

    if (state.kind === "free") {
      return {
        tone: "neutral",
        label: "No training session today",
        detail: lvl
          ? `${lvl} has ${targets.length} documented subspecialty target${targets.length === 1 ? "" : "s"}. Today's free slot does not advance any of them.`
          : "No training level recorded — cannot match against subspecialty targets.",
      };
    }
    if (state.kind === "excluded") {
      return {
        tone: "neutral",
        label: `${state.reason} — outside theatre targets`,
        detail: "Non-theatre duty: does not advance subspecialty / solo / supervised list counts.",
      };
    }
    // theatre list
    const specName = state.specialtyName ?? "unmapped specialty";
    if (!lvl) {
      return {
        tone: "neutral",
        label: `On ${specName} list — no training level on file`,
        detail: "Cannot check against trainee_targets without a training level.",
      };
    }
    if (targets.length === 0) {
      return {
        tone: "neutral",
        label: `No ${lvl} targets recorded`,
        detail: `Add rows in trainee_targets for ${lvl} to track ${specName} progress.`,
      };
    }
    const match = state.specialtyId
      ? targets.find((t) => t.specialty_id === state.specialtyId)
      : undefined;
    if (!match) {
      return {
        tone: "miss",
        label: `${specName} is not a ${lvl} subspecialty target`,
        detail: `Required ${lvl} subspecialties: ${targets
          .map((t) => specialtyNameById.get(t.specialty_id) ?? "?")
          .join(", ")}.`,
      };
    }
    const role = (state.role ?? "").toLowerCase();
    const isSolo = role === "solo";
    const isSupervised = role === "supervised" || role === "supervisee" || role === "trainee";
    const counts: string[] = [`session (target ${match.required_sessions})`];
    if (isSolo && match.required_solo > 0) counts.push(`solo (target ${match.required_solo})`);
    if (isSupervised && match.required_supervised > 0) counts.push(`supervised (target ${match.required_supervised})`);
    return {
      tone: "good",
      label: `Counts toward ${specName}: ${isSolo ? "solo" : isSupervised ? "supervised" : "session"}`,
      detail: `${lvl} ${specName} — advances ${counts.join(" + ")}.`,
    };
  };

  const buildBreakdown = (half: SessionHalf): HalfBreakdown => {
    const entries: StaffStatusEntry[] = [];
    for (const [id, p] of profById.entries()) {
      const ref: PersonRef = {
        staffId: id,
        staffName: p.full_name,
        grade: p.grade,
        trainingLevel: p.training_level,
      };
      if (leaveTypeByStaff.has(id)) {
        entries.push({
          ...ref,
          category: "on_leave",
          reason: `${leaveTypeByStaff.get(id)} leave (approved)`,
          countsToSolo: false,
        });
        continue;
      }
      if (p.ltft_days_off.includes(dow)) {
        entries.push({ ...ref, category: "ltft_off", reason: "LTFT non-working day", countsToSolo: false });
        continue;
      }
      const exDuty = excludedAllDay.get(id);
      if (exDuty) {
        entries.push({
          ...ref,
          category: "on_excluded_duty",
          reason: formatDutyLabel(exDuty),
          countsToSolo: false,
          trainingNote: traineeNote(ref, { kind: "excluded", reason: formatDutyLabel(exDuty) }),
        });
        continue;
      }
      const ha = halfAssn[half].get(id);
      if (ha?.kind === "theatre") {
        const info = tsInfoById.get(ha.theatreSessionId);
        const sessionLabel = half.toUpperCase(); // AM / PM
        const specialty = info?.specialty ?? "specialty not mapped";
        const theatre = info?.theatreName ?? "a theatre list";
        entries.push({
          ...ref,
          category: "on_clinical_list",
          reason: `Covering ${theatre} — ${sessionLabel} · ${specialty}`,
          countsToSolo: false,
          trainingNote: traineeNote(ref, {
            kind: "theatre",
            specialtyId: info?.specialtyId ?? null,
            specialtyName: info?.specialty ?? null,
            role: ha.role,
          }),
        });
        continue;
      }

      if (ha?.kind === "spa" && p.grade === "consultant") {
        entries.push({
          ...ref,
          category: "on_spa",
          reason: "Scheduled SPA — flexible cover",
          countsToSolo: false,
        });
        continue;
      }
      const fe = freeEntry(ref);
      if (ref.grade === "trainee") {
        fe.trainingNote = traineeNote(ref, { kind: "free" });
      }
      entries.push(fe);
    }
    entries.sort((a, b) => compareBySurname(a.staffName, b.staffName));
    return { session: half, entries };
  };

  return {
    date,
    dow,
    sessions,
    onLeave,
    ltftOff,
    onOtherDuty,
    consultantsOnSpa: spa,
    am: day?.am ?? empty,
    pm: day?.pm ?? empty,
    amBreakdown: buildBreakdown("am"),
    pmBreakdown: buildBreakdown("pm"),
  };
}

function freeEntry(ref: PersonRef): StaffStatusEntry {
  if (ref.grade === "consultant") {
    return { ...ref, category: "free_consultant", reason: "Free — no leave, duty, or list assignment", countsToSolo: true };
  }
  if (ref.grade === "trainee") {
    if (isSeniorTrainee(ref.trainingLevel)) {
      return { ...ref, category: "free_senior_trainee", reason: `Free senior trainee (${ref.trainingLevel}) — solo-capable`, countsToSolo: true };
    }
    return { ...ref, category: "free_junior_trainee", reason: `Free junior trainee (${ref.trainingLevel ?? "—"}) — needs supervision`, countsToSolo: false };
  }
  if (ref.grade === "sas") {
    return { ...ref, category: "free_sas", reason: "Free SAS — pairs with a consultant", countsToSolo: false };
  }
  return { ...ref, category: "free_consultant", reason: "Free (grade unknown)", countsToSolo: false };
}

function formatDutyLabel(dt: string): string {
  const map: Record<string, string> = {
    icu_consultant_oncall: "ICU consultant on-call",
    general_consultant_oncall: "General consultant on-call",
    registrar_oncall: "Registrar on-call",
    sho_oncall: "SHO on-call",
    icu_trainee: "ICU trainee",
    icu_ct2_plus: "ICU (CT2+)",
    obstetrics: "Obstetrics",
    obstetrics_2nd: "Obstetrics (2nd on)",
    consultant_in_charge: "Consultant in charge",
    teaching: "Teaching",
    non_clinical: "Non-clinical",
    admin: "Admin",
  };
  return map[dt] ?? dt.replace(/_/g, " ");
}
