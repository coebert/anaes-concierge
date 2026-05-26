import type { Database } from "@/integrations/supabase/types";

export type Severity = "error" | "warning" | "info";
export interface Issue {
  severity: Severity;
  message: string;
}

type Sess = "am" | "pm";
type RotaRole = Database["public"]["Enums"]["rota_role"];

interface Assignment {
  id: string;
  staff_id: string;
  session: Sess;
  session_date: string;
  theatre_session_id: string | null;
  role_on_list: RotaRole;
}

interface JobPlan {
  staff_id: string;
  total_pas: number;
  dcc_pas: number;
  spa_pas: number;
  ltft: boolean;
  ltft_percentage: number | null;
  valid_from: string;
  valid_to: string | null;
}

interface LeaveRequest {
  staff_id: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface FixedSession {
  staff_id: string;
  day_of_week: number; // 0=Sun..6=Sat in JS; our table stores 0=Mon..6=Sun
  session: Sess;
}

export interface RotaRules {
  sessions_per_pa: number;
  max_sessions_per_week: number;
  max_consecutive_days: number;
  honour_fixed_sessions: boolean;
  allow_back_to_back_oncall: boolean;
}

export interface Profile {
  id: string;
  full_name: string;
  grade: "consultant" | "sas" | "trainee" | null;
  training_level: string | null;
}

const DCC_ROLES: RotaRole[] = ["solo", "supervised", "supervising", "on_call"];

function dayIndexMonFirst(iso: string): number {
  const js = new Date(iso + "T00:00:00").getDay(); // 0=Sun..6=Sat
  return (js + 6) % 7; // 0=Mon..6=Sun
}

function jobPlanFor(plans: JobPlan[], staffId: string, dateISO: string): JobPlan | undefined {
  const candidates = plans.filter(
    (p) =>
      p.staff_id === staffId &&
      p.valid_from <= dateISO &&
      (!p.valid_to || p.valid_to >= dateISO),
  );
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
  return candidates[0];
}

/** Validate adding a candidate assignment, given current week context. */
export function validateAssignment(args: {
  candidateStaffId: string;
  role: RotaRole;
  date: string;
  session: Sess;
  weekDates: string[]; // ISO Mon..Fri (or longer) of the working week
  weekAssignments: Assignment[]; // all assignments in week (excluding the new one)
  profiles: Profile[];
  jobPlans: JobPlan[];
  leave: LeaveRequest[];
  fixedSessions: FixedSession[];
  rules: RotaRules;
}): Issue[] {
  const {
    candidateStaffId, role, date, session, weekDates,
    weekAssignments, profiles, jobPlans, leave, fixedSessions, rules,
  } = args;
  const issues: Issue[] = [];
  const profile = profiles.find((p) => p.id === candidateStaffId);

  // 1. Double-booking at same date+session
  const clash = weekAssignments.find(
    (a) => a.staff_id === candidateStaffId && a.session_date === date && a.session === session,
  );
  if (clash) {
    issues.push({
      severity: "error",
      message: "Already assigned to another session at this date and time.",
    });
  }

  // 2. Approved leave overlap
  const onLeave = leave.find(
    (l) =>
      l.staff_id === candidateStaffId &&
      l.status === "approved" &&
      l.start_date <= date &&
      l.end_date >= date,
  );
  if (onLeave) {
    issues.push({ severity: "error", message: "Approved leave covers this date." });
  }

  // 3. Trainee assigned 'supervised' must have a supervising consultant on the same list (warning only)
  if (role === "supervised" && profile?.grade !== "trainee") {
    issues.push({
      severity: "warning",
      message: "Role 'supervised' is intended for trainees.",
    });
  }
  if (profile?.grade === "trainee" && (role === "supervising" || role === "solo")) {
    issues.push({
      severity: "warning",
      message: "Trainee assigned without supervisor — verify competency sign-off.",
    });
  }

  // 4. PA / DCC load against job plan
  const jp = jobPlanFor(jobPlans, candidateStaffId, date);
  const sessionsPerPa = rules.sessions_per_pa || 1;
  const staffWeek = [
    ...weekAssignments.filter((a) => a.staff_id === candidateStaffId),
    { staff_id: candidateStaffId, session, session_date: date, role_on_list: role } as Assignment,
  ];
  const totalSessions = staffWeek.length;
  const dccSessions = staffWeek.filter((a) => DCC_ROLES.includes(a.role_on_list)).length;

  if (totalSessions > rules.max_sessions_per_week) {
    issues.push({
      severity: "error",
      message: `Exceeds max sessions/week (${totalSessions} > ${rules.max_sessions_per_week}).`,
    });
  }

  if (jp) {
    const allowedDcc = jp.dcc_pas * sessionsPerPa;
    const ltftFactor = jp.ltft && jp.ltft_percentage ? jp.ltft_percentage / 100 : 1;
    const effectiveDcc = allowedDcc * ltftFactor;
    if (dccSessions > effectiveDcc) {
      issues.push({
        severity: "warning",
        message: `DCC sessions ${dccSessions} exceed job-plan budget ${effectiveDcc.toFixed(1)}${
          jp.ltft ? ` (LTFT ${jp.ltft_percentage}%)` : ""
        }.`,
      });
    } else if (dccSessions > effectiveDcc - 0.5) {
      issues.push({
        severity: "info",
        message: `At DCC capacity (${dccSessions}/${effectiveDcc.toFixed(1)}).`,
      });
    }
  } else {
    issues.push({
      severity: "info",
      message: "No active job plan — load checks skipped.",
    });
  }

  // 5. Max consecutive days
  const daysWorked = new Set(staffWeek.map((a) => a.session_date));
  const sortedWeek = [...weekDates].sort();
  let run = 0, maxRun = 0;
  for (const d of sortedWeek) {
    if (daysWorked.has(d)) {
      run += 1;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  if (maxRun > rules.max_consecutive_days) {
    issues.push({
      severity: "warning",
      message: `Working ${maxRun} consecutive days (limit ${rules.max_consecutive_days}).`,
    });
  }

  // 6. Back-to-back on-call
  if (role === "on_call" && !rules.allow_back_to_back_oncall) {
    const prev = new Date(date); prev.setDate(prev.getDate() - 1);
    const next = new Date(date); next.setDate(next.getDate() + 1);
    const prevISO = prev.toISOString().slice(0, 10);
    const nextISO = next.toISOString().slice(0, 10);
    const adj = weekAssignments.find(
      (a) =>
        a.staff_id === candidateStaffId &&
        a.role_on_list === "on_call" &&
        (a.session_date === prevISO || a.session_date === nextISO),
    );
    if (adj) {
      issues.push({
        severity: "error",
        message: "Back-to-back on-call is not permitted by current rules.",
      });
    }
  }

  // 7. Honour fixed sessions
  if (rules.honour_fixed_sessions) {
    const dow = dayIndexMonFirst(date);
    const fixed = fixedSessions.filter(
      (f) => f.staff_id === candidateStaffId && f.day_of_week === dow && f.session === session,
    );
    const fixedElsewhere = fixedSessions.find(
      (f) =>
        f.staff_id === candidateStaffId &&
        f.day_of_week === dow &&
        f.session === session &&
        // No specific theatre check here — we just warn if fixed exists and this date overrides it
        false,
    );
    if (!fixed.length && fixedSessions.some((f) => f.staff_id === candidateStaffId)) {
      // Staff has a fixed pattern but this slot isn't one — informational
      issues.push({
        severity: "info",
        message: "Outside this person's fixed weekly pattern.",
      });
    }
    void fixedElsewhere;
  }

  return issues;
}

export function severityRank(s: Severity): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

export function worstSeverity(issues: Issue[]): Severity | null {
  if (!issues.length) return null;
  return issues.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0].severity;
}
