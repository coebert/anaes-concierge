// Pure helpers for the "ICU sessions & PAs" audit page.
//
// Counting rules (agreed with the department):
//   - ICU duty types only (icu_consultant_oncall / icu_ct2_plus / icu_trainee).
//   - Daytime sessions are the `am` / `pm` halves; `eve` / `night` halves are
//     on-call. Multiple on-call halves on the same date collapse to one
//     on-call.
//   - A "day worked" is a distinct date with at least one daytime session.
//   - Weekend ICU days (Sat/Sun, daytime or on-call) are reported separately.
//   - Rows tagged `extra_type` (extra / locum / WLI / SAG) are kept out of the
//     job-planned totals and reported in their own columns.
//   - PAs come from the department rota rules, never hard-coded here.

export type IcuSessionHalf = "am" | "pm" | "eve" | "night";

export type IcuRow = {
  staff_id: string | null;
  session_date: string | null;
  session: IcuSessionHalf | string | null;
  duty_type: string | null;
  extra_type: string | null;
  /** PA value recorded by CLWRota for this row; null/undefined → derive from rules. */
  pa_credit?: number | null;
  /** Every consultant/SAS profile named on the row. Empty → credit staff_id only. */
  attending_consultant_ids?: string[] | null;
};

export type IcuPaRules = {
  /** Clinical sessions that make up one PA. */
  sessions_per_pa: number;
  /** PA credit awarded per on-call. */
  oncall_pa_credit: number;
  /** PA credit awarded per weekend day worked. */
  weekend_pa_credit: number;
};

export const ICU_DUTY_TYPES = [
  "icu_consultant_oncall",
  "icu_ct2_plus",
  "icu_trainee",
] as const;

export function isWeekendISO(isoDate: string): boolean {
  // UTC noon avoids DST / TZ edge cases at date boundaries.
  const dow = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isDaytimeHalf(session: string | null): boolean {
  return session === "am" || session === "pm";
}

export function isOnCallHalf(session: string | null): boolean {
  return session === "eve" || session === "night";
}

/** True when the row is not job-planned work (extra / locum / WLI / SAG). */
export function isExtraRow(row: IcuRow): boolean {
  return Boolean(row.extra_type && row.extra_type.trim() !== "");
}

export type IcuStaffTally = {
  staff_id: string;
  /** Distinct dates with a job-planned daytime ICU session. */
  days: number;
  /** Job-planned daytime session halves (AM + PM). */
  sessions: number;
  amSessions: number;
  pmSessions: number;
  /** Distinct dates with a job-planned ICU on-call (eve and/or night). */
  onCalls: number;
  /** Distinct weekend dates (job-planned, daytime or on-call). */
  weekendDays: number;
  /** Distinct dates of non-job-planned ICU work. */
  extraDays: number;
  /** Non-job-planned ICU session halves. */
  extraSessions: number;
  /** PAs from job-planned ICU work. */
  plannedPas: number;
  /** PAs from extra / locum / WLI / SAG ICU work (daytime equivalent). */
  extraPas: number;
  totalPas: number;
  /** Sorted list of every distinct ICU date behind these numbers. */
  dates: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Tally ICU activity per staff member and convert it into PAs using the
 * department rota rules.
 */
export function tallyIcuWorkload(
  rows: readonly IcuRow[],
  rules: IcuPaRules,
): IcuStaffTally[] {
  const sessionsPerPa = rules.sessions_per_pa > 0 ? rules.sessions_per_pa : 1;

  type Acc = {
    dayDates: Set<string>;
    onCallDates: Set<string>;
    weekendDates: Set<string>;
    extraDates: Set<string>;
    allDates: Set<string>;
    am: number;
    pm: number;
    extraSessions: number;
  };
  const byStaff = new Map<string, Acc>();

  const acc = (id: string): Acc => {
    let a = byStaff.get(id);
    if (!a) {
      a = {
        dayDates: new Set(),
        onCallDates: new Set(),
        weekendDates: new Set(),
        extraDates: new Set(),
        allDates: new Set(),
        am: 0,
        pm: 0,
        extraSessions: 0,
      };
      byStaff.set(id, a);
    }
    return a;
  };

  for (const r of rows) {
    if (!r.staff_id || !r.session_date) continue;
    if (!r.duty_type || !(ICU_DUTY_TYPES as readonly string[]).includes(r.duty_type)) {
      continue;
    }
    const a = acc(r.staff_id);
    a.allDates.add(r.session_date);

    if (isExtraRow(r)) {
      a.extraDates.add(r.session_date);
      a.extraSessions += 1;
      continue;
    }

    if (isDaytimeHalf(r.session)) {
      a.dayDates.add(r.session_date);
      if (r.session === "am") a.am += 1;
      else a.pm += 1;
    } else if (isOnCallHalf(r.session)) {
      a.onCallDates.add(r.session_date);
    } else {
      continue;
    }

    if (isWeekendISO(r.session_date)) a.weekendDates.add(r.session_date);
  }

  const out: IcuStaffTally[] = [];
  for (const [staff_id, a] of byStaff) {
    const sessions = a.am + a.pm;
    const onCalls = a.onCallDates.size;
    const weekendDays = a.weekendDates.size;

    const plannedPas = round2(
      sessions / sessionsPerPa +
        onCalls * rules.oncall_pa_credit +
        weekendDays * rules.weekend_pa_credit,
    );
    const extraPas = round2(a.extraSessions / sessionsPerPa);

    out.push({
      staff_id,
      days: a.dayDates.size,
      sessions,
      amSessions: a.am,
      pmSessions: a.pm,
      onCalls,
      weekendDays,
      extraDays: a.extraDates.size,
      extraSessions: a.extraSessions,
      plannedPas,
      extraPas,
      totalPas: round2(plannedPas + extraPas),
      dates: Array.from(a.allDates).sort(),
    });
  }

  return out
    .filter(
      (t) =>
        t.days > 0 || t.onCalls > 0 || t.extraDays > 0 || t.weekendDays > 0,
    )
    .sort((a, b) => b.totalPas - a.totalPas || a.staff_id.localeCompare(b.staff_id));
}
