// Pure helpers for the appraisal year page.
//
// An appraisal year runs 1 April to 31 March. For one doctor it rolls their
// whole year of CLWRota work into: intensive care totals, everything else
// broken down by specialty/duty, month-by-month activity, and a list of
// evidence gaps a doctor would need to explain at appraisal.

import {
  creditedStaffIds,
  ICU_DUTY_TYPES,
  isDaytimeHalf,
  isExtraRow,
  isOnCallHalf,
} from "./icu-workload";
import {
  areaForRow,
  tallySpecialtyWorkload,
  type SpecialtyPaRules,
  type SpecialtyRow,
  type SpecialtyTally,
} from "./specialty-workload";

const ICU_SET = new Set<string>(ICU_DUTY_TYPES);

export function isIcuRow(row: SpecialtyRow): boolean {
  return ICU_SET.has(row.duty_type ?? "");
}

export function isIcuArea(area: string): boolean {
  return area === "Intensive care";
}

/** Appraisal year (April–March) containing the given date. */
export function appraisalYearOf(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return (m ?? 1) >= 4 ? (y ?? 0) : (y ?? 0) - 1;
}

export function appraisalYearRange(year: number): { from: string; to: string } {
  return { from: `${year}-04-01`, to: `${year + 1}-03-31` };
}

export function appraisalYearLabel(year: number): string {
  return `${year}/${String((year + 1) % 100).padStart(2, "0")}`;
}

/** The twelve `YYYY-MM` months of an appraisal year, in order. */
export function appraisalYearMonths(year: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const m = 4 + i;
    const yy = m > 12 ? year + 1 : year;
    const mm = m > 12 ? m - 12 : m;
    out.push(`${yy}-${String(mm).padStart(2, "0")}`);
  }
  return out;
}

export type AppraisalTotals = {
  days: number;
  sessions: number;
  onCalls: number;
  weekendDays: number;
  plannedPas: number;
  extraPas: number;
  totalPas: number;
  clwrotaPas: number;
  estimatedPas: number;
};

function emptyTotals(): AppraisalTotals {
  return {
    days: 0,
    sessions: 0,
    onCalls: 0,
    weekendDays: 0,
    plannedPas: 0,
    extraPas: 0,
    totalPas: 0,
    clwrotaPas: 0,
    estimatedPas: 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addTally(total: AppraisalTotals, t: SpecialtyTally): AppraisalTotals {
  return {
    days: total.days + t.days,
    sessions: total.sessions + t.sessions,
    onCalls: total.onCalls + t.onCalls,
    weekendDays: total.weekendDays + t.weekendDays,
    plannedPas: round2(total.plannedPas + t.plannedPas),
    extraPas: round2(total.extraPas + t.extraPas),
    totalPas: round2(total.totalPas + t.totalPas),
    clwrotaPas: round2(total.clwrotaPas + t.clwrotaPas),
    estimatedPas: round2(total.estimatedPas + t.estimatedPas),
  };
}

export type MonthActivity = {
  month: string;
  sessions: number;
  onCalls: number;
  icuSessions: number;
  recordedRows: number;
  rows: number;
};

export type AppraisalGap = {
  kind: "no-activity-month" | "unrecorded-pas" | "no-icu";
  label: string;
  detail: string;
};

export type AppraisalYearSummary = {
  year: number;
  label: string;
  from: string;
  to: string;
  icu: AppraisalTotals;
  other: AppraisalTotals;
  overall: AppraisalTotals;
  icuAreas: SpecialtyTally[];
  otherAreas: SpecialtyTally[];
  months: MonthActivity[];
  gaps: AppraisalGap[];
};

/**
 * Build one doctor's appraisal-year picture from their rota rows.
 * `rows` may include rows credited to other doctors; only `staffId`'s work counts.
 */
export function buildAppraisalYear(
  staffId: string,
  year: number,
  rows: readonly SpecialtyRow[],
  rules: SpecialtyPaRules,
): AppraisalYearSummary {
  const { from, to } = appraisalYearRange(year);
  const inRange = rows.filter(
    (r) => r.session_date && r.session_date >= from && r.session_date <= to,
  );

  const tallies = tallySpecialtyWorkload(inRange, rules).filter((t) => t.staff_id === staffId);
  const icuAreas = tallies.filter((t) => isIcuArea(t.area));
  const otherAreas = tallies.filter((t) => !isIcuArea(t.area));

  const icu = icuAreas.reduce(addTally, emptyTotals());
  const other = otherAreas.reduce(addTally, emptyTotals());
  const overall = tallies.reduce(addTally, emptyTotals());

  // Month-by-month activity, from the doctor's own credited rows.
  const mine = inRange.filter((r) => {
    return creditedStaffIds(r).includes(staffId);
  });

  const monthMap = new Map<string, MonthActivity>();
  for (const month of appraisalYearMonths(year)) {
    monthMap.set(month, {
      month,
      sessions: 0,
      onCalls: 0,
      icuSessions: 0,
      recordedRows: 0,
      rows: 0,
    });
  }
  const onCallSeen = new Set<string>();
  let unrecordedRows = 0;

  for (const r of mine) {
    const date = r.session_date!;
    const month = date.slice(0, 7);
    const m = monthMap.get(month);
    if (!m) continue;
    if (!isDaytimeHalf(r.session) && !isOnCallHalf(r.session)) continue;

    m.rows += 1;
    if (typeof r.pa_credit === "number" && Number.isFinite(r.pa_credit)) m.recordedRows += 1;
    else if (!isExtraRow(r)) unrecordedRows += 1;

    if (isDaytimeHalf(r.session)) {
      m.sessions += 1;
      if (isIcuRow(r)) m.icuSessions += 1;
    } else {
      const key = `${date}`;
      if (!onCallSeen.has(key)) {
        onCallSeen.add(key);
        m.onCalls += 1;
      }
      if (isIcuRow(r)) m.icuSessions += 0;
    }
  }

  const months = appraisalYearMonths(year).map((m) => monthMap.get(m)!);

  const gaps: AppraisalGap[] = [];
  const emptyMonths = months.filter((m) => m.rows === 0).map((m) => m.month);
  if (emptyMonths.length > 0) {
    gaps.push({
      kind: "no-activity-month",
      label: `${emptyMonths.length} month${emptyMonths.length === 1 ? "" : "s"} with no rota activity`,
      detail: `No sessions or on-calls are recorded for ${emptyMonths.join(", ")}. Either no work was rostered, or CLWRota has not been synced for that period yet.`,
    });
  }
  if (unrecordedRows > 0) {
    gaps.push({
      kind: "unrecorded-pas",
      label: `${unrecordedRows} session${unrecordedRows === 1 ? "" : "s"} without a CLWRota PA value`,
      detail:
        "These sessions are on the rota but CLWRota has not stored a programmed-activity value for them, so their PAs are estimated from the department rota rules.",
    });
  }
  if (icu.sessions === 0 && icu.onCalls === 0) {
    gaps.push({
      kind: "no-icu",
      label: "No intensive care work in this appraisal year",
      detail:
        "Nothing classified as intensive care was found for this doctor in this period. If they do work on ICU, check the intensive care audit and run a backfill for the missing dates.",
    });
  }

  return {
    year,
    label: appraisalYearLabel(year),
    from,
    to,
    icu,
    other,
    overall,
    icuAreas,
    otherAreas,
    months,
    gaps,
  };
}

export { areaForRow };
