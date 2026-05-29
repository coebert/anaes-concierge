import { supabase } from "@/integrations/supabase/client";

export type Grade = "consultant" | "sas" | "trainee" | "unknown";
export type SessionHalf = "am" | "pm";

export interface ExtraAbsence {
  staffId?: string;
  grade?: Grade; // when set without staffId, counts as N absences in that grade
  count?: number;
}

export interface SessionLoad {
  date: string;
  session: SessionHalf;
  required: number; // theatre sessions needing staff
}

export interface DayCapacity {
  date: string;
  dow: number; // 1..5
  am: HalfDayCapacity;
  pm: HalfDayCapacity;
}

export interface HalfDayCapacity {
  required: number;
  available: number;
  byGrade: Record<Grade, number>;
  onLeave: number;
  headroom: number; // available - required
  risk: "ok" | "tight" | "shortfall";
  unfilled: number; // sessions with no rota_assignment yet
}

const RISK_TIGHT = 1; // headroom <= 1 -> tight
const RISK_SHORTFALL = 0; // headroom < 0 -> shortfall

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

function classify(headroom: number): HalfDayCapacity["risk"] {
  if (headroom < RISK_SHORTFALL) return "shortfall";
  if (headroom <= RISK_TIGHT) return "tight";
  return "ok";
}

export async function computeRobustness(
  rangeStart: string,
  rangeEnd: string,
  extraAbsences: ExtraAbsence[] = [],
): Promise<{ days: DayCapacity[]; totalStaffByGrade: Record<Grade, number> }> {
  // 1. Active workforce by grade.
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, grade, ltft_days_off")
    .eq("active", true);

  const staff = (profiles ?? []) as Array<{
    id: string;
    grade: string | null;
    ltft_days_off: number[] | null;
  }>;

  const totalStaffByGrade: Record<Grade, number> = {
    consultant: 0, sas: 0, trainee: 0, unknown: 0,
  };
  for (const s of staff) {
    const g = (s.grade as Grade) ?? "unknown";
    totalStaffByGrade[g] = (totalStaffByGrade[g] ?? 0) + 1;
  }

  // 2. Approved leave overlapping the range.
  const { data: leave } = await supabase
    .from("leave_requests")
    .select("staff_id, start_date, end_date, status")
    .eq("status", "approved")
    .lte("start_date", rangeEnd)
    .gte("end_date", rangeStart);

  // staff_id -> Set<date>
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

  // 3. Theatre sessions (what NEEDS to be staffed).
  const { data: theatreSessions } = await supabase
    .from("theatre_sessions")
    .select("session_date, session")
    .gte("session_date", rangeStart)
    .lte("session_date", rangeEnd);

  const requiredMap = new Map<string, { am: number; pm: number }>();
  for (const t of theatreSessions ?? []) {
    const r = requiredMap.get(t.session_date as string) ?? { am: 0, pm: 0 };
    if (t.session === "am") r.am += 1;
    if (t.session === "pm") r.pm += 1;
    requiredMap.set(t.session_date as string, r);
  }

  // 4. Currently filled assignments (so we can flag unfilled lists).
  const { data: assignments } = await supabase
    .from("rota_assignments")
    .select("session_date, session, theatre_session_id, duty_type")
    .eq("duty_type", "theatre")
    .gte("session_date", rangeStart)
    .lte("session_date", rangeEnd);

  const filledMap = new Map<string, { am: Set<string>; pm: Set<string> }>();
  for (const a of assignments ?? []) {
    if (!a.theatre_session_id) continue;
    const cur = filledMap.get(a.session_date as string) ?? { am: new Set(), pm: new Set() };
    if (a.session === "am") cur.am.add(a.theatre_session_id as string);
    if (a.session === "pm") cur.pm.add(a.theatre_session_id as string);
    filledMap.set(a.session_date as string, cur);
  }

  // 5. Hypothetical absences (for what-if simulator).
  const extraStaffOff = new Set<string>();
  const extraByGrade: Record<Grade, number> = {
    consultant: 0, sas: 0, trainee: 0, unknown: 0,
  };
  for (const x of extraAbsences) {
    if (x.staffId) extraStaffOff.add(x.staffId);
    else if (x.grade) extraByGrade[x.grade] = (extraByGrade[x.grade] ?? 0) + (x.count ?? 1);
  }

  // 6. Compute per-day capacity.
  const days: DayCapacity[] = [];
  for (const date of eachWeekday(rangeStart, rangeEnd)) {
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const offToday = leaveByDate.get(date) ?? new Set<string>();

    // Per-grade availability: active staff this grade, minus on-leave, minus
    // LTFT days-off, minus named extra absences, minus by-grade extra absences.
    const availByGrade: Record<Grade, number> = {
      consultant: 0, sas: 0, trainee: 0, unknown: 0,
    };
    for (const s of staff) {
      const g = (s.grade as Grade) ?? "unknown";
      if (offToday.has(s.id)) continue;
      if (extraStaffOff.has(s.id)) continue;
      if ((s.ltft_days_off ?? []).includes(dow)) continue;
      availByGrade[g] = (availByGrade[g] ?? 0) + 1;
    }
    for (const g of Object.keys(extraByGrade) as Grade[]) {
      availByGrade[g] = Math.max(0, (availByGrade[g] ?? 0) - extraByGrade[g]);
    }
    const available = Object.values(availByGrade).reduce((a, b) => a + b, 0);
    const required = requiredMap.get(date) ?? { am: 0, pm: 0 };
    const filled = filledMap.get(date) ?? { am: new Set<string>(), pm: new Set<string>() };

    const onLeaveCount = offToday.size + extraStaffOff.size
      + Object.values(extraByGrade).reduce((a, b) => a + b, 0);

    const mkHalf = (req: number, filledIds: Set<string>): HalfDayCapacity => {
      const unfilled = Math.max(0, req - filledIds.size);
      // Each half-day, a person covers one session — treat headroom as
      // available staff minus the lists that need covering this half-day.
      const headroom = available - req;
      return {
        required: req,
        available,
        byGrade: availByGrade,
        onLeave: onLeaveCount,
        headroom,
        risk: classify(headroom),
        unfilled,
      };
    };

    days.push({
      date,
      dow,
      am: mkHalf(required.am, filled.am),
      pm: mkHalf(required.pm, filled.pm),
    });
  }

  return { days, totalStaffByGrade };
}

export function riskColor(risk: HalfDayCapacity["risk"]): string {
  if (risk === "shortfall") return "bg-red-500/80 text-white";
  if (risk === "tight") return "bg-amber-400/80";
  return "bg-emerald-300/50";
}
