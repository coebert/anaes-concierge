import { supabase } from "@/integrations/supabase/client";

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

/** Duty types that take a person out of the theatre-cover pool entirely. */
const UNAVAILABLE_DUTY_TYPES = new Set<string>([
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

/** Duty types that COULD be redeployed onto a list but should be flagged. */
const FLEX_DUTY_TYPES = new Set<string>(["spa"]);

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


export async function computeRobustness(
  rangeStart: string,
  rangeEnd: string,
  extraAbsences: ExtraAbsence[] = [],
): Promise<{ days: DayCapacity[]; totalStaffByGrade: Record<Grade, number> }> {
  const [{ data: profiles }, { data: leave }, { data: theatreSessions }, { data: assignments }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("id, grade, training_level, ltft_days_off")
        .eq("active", true),
      supabase
        .from("leave_requests")
        .select("staff_id, start_date, end_date, status")
        .eq("status", "approved")
        .lte("start_date", rangeEnd)
        .gte("end_date", rangeStart),
      supabase
        .from("theatre_sessions")
        .select("session_date, session")
        .gte("session_date", rangeStart)
        .lte("session_date", rangeEnd),
      supabase
        .from("rota_assignments")
        .select("staff_id, session_date, session, duty_type, theatre_session_id")
        .gte("session_date", rangeStart)
        .lte("session_date", rangeEnd),
    ]);

  const staff = (profiles ?? []) as Array<{
    id: string;
    grade: string | null;
    training_level: string | null;
    ltft_days_off: number[] | null;
  }>;

  const totalStaffByGrade: Record<Grade, number> = {
    consultant: 0, sas: 0, trainee: 0, unknown: 0,
  };
  for (const s of staff) {
    const g = (s.grade as Grade) ?? "unknown";
    totalStaffByGrade[g] = (totalStaffByGrade[g] ?? 0) + 1;
  }

  // staff_id -> set of dates on approved leave
  const leaveByDate = new Map<string, Set<string>>();
  for (const l of leave ?? []) {
    const from = new Date(((l.start_date as string) < rangeStart ? rangeStart : (l.start_date as string)) + "T00:00:00Z");
    const to = new Date(((l.end_date as string) > rangeEnd ? rangeEnd : (l.end_date as string)) + "T00:00:00Z");
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const set = leaveByDate.get(iso) ?? new Set();
      set.add(l.staff_id as string);
      leaveByDate.set(iso, set);
    }
  }

  // theatre lists requiring cover per date
  const requiredMap = new Map<string, { am: number; pm: number }>();
  for (const t of theatreSessions ?? []) {
    const r = requiredMap.get(t.session_date as string) ?? { am: 0, pm: 0 };
    if (t.session === "am") r.am += 1;
    if (t.session === "pm") r.pm += 1;
    requiredMap.set(t.session_date as string, r);
  }

  // assignments indexed by (date, session) and (date, staff)
  type AsnState = "theatre" | "spa" | "unavailable";
  const staffStateByDateSession = new Map<string, Map<string, AsnState>>();
  // also track any-session unavailability (e.g. on-call spanning the day)
  const dailyUnavailable = new Map<string, Set<string>>();
  const dailySpa = new Map<string, Set<string>>();
  const filledMap = new Map<string, { am: Set<string>; pm: Set<string> }>();

  for (const a of assignments ?? []) {
    const date = a.session_date as string;
    const sess = a.session as string; // am/pm/eve/night
    const sid = a.staff_id as string;
    const dt = a.duty_type as string;

    if (dt === "theatre" && a.theatre_session_id && (sess === "am" || sess === "pm")) {
      const cur = filledMap.get(date) ?? { am: new Set<string>(), pm: new Set<string>() };
      (sess === "am" ? cur.am : cur.pm).add(a.theatre_session_id as string);
      filledMap.set(date, cur);
    }

    // Any non-theatre duty that day takes the person off the pool.
    if (UNAVAILABLE_DUTY_TYPES.has(dt)) {
      const set = dailyUnavailable.get(date) ?? new Set<string>();
      set.add(sid);
      dailyUnavailable.set(date, set);
    } else if (FLEX_DUTY_TYPES.has(dt)) {
      const key = `${date}|${sess}`;
      const sm = staffStateByDateSession.get(key) ?? new Map<string, AsnState>();
      // SPA only flags the specific session it covers
      if (sess === "am" || sess === "pm") {
        sm.set(sid, "spa");
        staffStateByDateSession.set(key, sm);
        const set = dailySpa.get(`${date}|${sess}`) ?? new Set<string>();
        set.add(sid);
        dailySpa.set(`${date}|${sess}`, set);
      }
    } else if (dt === "theatre" && (sess === "am" || sess === "pm")) {
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

  const [
    { data: theatreSessions },
    { data: profiles },
    { data: leave },
    { data: assignments },
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
    } else if (UNAVAILABLE_DUTY_TYPES.has(dt)) {
      otherDutyMap.set(sid + "|" + dt, { ...mkRef(sid), duty: dt, session: sess });
    } else if (FLEX_DUTY_TYPES.has(dt) && (sess === "am" || sess === "pm")) {
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
  })).sort((a, b) => a.staffName.localeCompare(b.staffName));

  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  const ltftOff: PersonRef[] = [...profById.entries()]
    .filter(([, p]) => p.ltft_days_off.includes(dow))
    .map(([id]) => mkRef(id))
    .sort((a, b) => a.staffName.localeCompare(b.staffName));

  const onOtherDuty = [...otherDutyMap.values()]
    .sort((a, b) => a.staffName.localeCompare(b.staffName));

  const empty: HalfDayCapacity = {
    required: 0, soloCapable: 0, consultantsAvailable: 0, seniorTraineesAvailable: 0,
    juniorTraineesAvailable: 0, sasAvailable: 0, consultantsOnSpa: 0, onLeave: 0,
    onOtherDuty: 0, headroom: 0, headroomWithSpa: 0, risk: "ok", unfilled: 0,
  };

  // ----- Per-half-day per-staff breakdown -----
  const tsInfoById = new Map<string, { theatreName: string; specialty: string | null }>();
  for (const t of ts) {
    tsInfoById.set(t.id as string, {
      theatreName: theatreNameById.get(t.theatre_id as string) ?? "—",
      specialty: t.specialty_id ? specialtyNameById.get(t.specialty_id as string) ?? null : null,
    });
  }

  const leaveTypeByStaff = new Map<string, string>();
  for (const l of leave ?? []) {
    leaveTypeByStaff.set(l.staff_id as string, l.type as string);
  }

  type HalfAssn =
    | { kind: "theatre"; theatreSessionId: string }
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
    if (UNAVAILABLE_DUTY_TYPES.has(dt)) {
      if (!excludedAllDay.has(sid)) excludedAllDay.set(sid, dt);
      continue;
    }
    if (sess !== "am" && sess !== "pm") continue;
    const half = sess as SessionHalf;
    if (dt === "theatre" && a.theatre_session_id) {
      halfAssn[half].set(sid, { kind: "theatre", theatreSessionId: a.theatre_session_id as string });
    } else if (FLEX_DUTY_TYPES.has(dt)) {
      if (!halfAssn[half].has(sid)) halfAssn[half].set(sid, { kind: "spa" });
    }
  }

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
      entries.push(freeEntry(ref));
    }
    entries.sort((a, b) => a.staffName.localeCompare(b.staffName));
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
