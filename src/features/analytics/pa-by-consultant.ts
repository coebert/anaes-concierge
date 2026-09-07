import { creditedStaffIds } from "./icu-workload";
// Pure aggregation for the "PAs by consultant" page.
//
// Splits each consultant's ICU PAs into:
//   - recorded PAs: values CLWRota stored on the rota row (pa_credit), and
//   - estimated PAs: rule-derived values for rows CLWRota gave no PA for.
// Rows without a stored PA are "evidence gaps" — the page flags them so an
// admin can see whose totals rest on estimates rather than source records.

import {
  ICU_DUTY_TYPES,
  isDaytimeHalf,
  isExtraRow,
  isOnCallHalf,
  isWeekendISO,
  type IcuPaRules,
  type IcuRow,
} from "./icu-workload";

export type PaConsultantTally = {
  staffId: string;
  /** ICU session halves credited to this consultant. */
  sessions: number;
  /** PAs taken from CLWRota's own recorded values. */
  recordedPas: number;
  /** PAs estimated from the rota rules (no recorded value). */
  estimatedPas: number;
  totalPas: number;
  /** Sessions with no recorded CLWRota PA — evidence gaps. */
  gapSessions: number;
  /** Distinct gap dates, for traceability. */
  gapDates: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function tallyPaByConsultant(
  rows: readonly IcuRow[],
  rules: IcuPaRules,
): PaConsultantTally[] {
  const sessionsPerPa = rules.sessions_per_pa > 0 ? rules.sessions_per_pa : 1;

  type Acc = {
    sessions: number;
    recordedPas: number;
    gapSessions: number;
    gapDates: Set<string>;
    // Rule-derived estimate parts for gap rows (same replacement rules as
    // tallyIcuWorkload: a weekend day is worth weekend_pa_credit only).
    uDaytime: number;
    uOnCallDates: Set<string>;
    uWeekendDates: Set<string>;
    uExtraSessions: number;
  };
  const byStaff = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = byStaff.get(id);
    if (!a) {
      a = {
        sessions: 0,
        recordedPas: 0,
        gapSessions: 0,
        gapDates: new Set(),
        uDaytime: 0,
        uOnCallDates: new Set(),
        uWeekendDates: new Set(),
        uExtraSessions: 0,
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
    const credited = creditedStaffIds(r);
    const stored = typeof r.pa_credit === "number" && Number.isFinite(r.pa_credit);
    const weekend = isWeekendISO(r.session_date);

    for (const id of credited) {
      const a = acc(id);
      a.sessions += 1;

      if (stored) {
        a.recordedPas += r.pa_credit as number;
        continue;
      }

      a.gapSessions += 1;
      a.gapDates.add(r.session_date);

      if (isExtraRow(r)) {
        a.uExtraSessions += 1;
      } else if (isDaytimeHalf(r.session)) {
        if (!weekend) a.uDaytime += 1;
        else a.uWeekendDates.add(r.session_date);
      } else if (isOnCallHalf(r.session)) {
        if (!weekend) a.uOnCallDates.add(r.session_date);
        else a.uWeekendDates.add(r.session_date);
      }
    }
  }

  const out: PaConsultantTally[] = [];
  for (const [staffId, a] of byStaff) {
    const estimatedPas = round2(
      a.uDaytime / sessionsPerPa +
        a.uOnCallDates.size * rules.oncall_pa_credit +
        a.uWeekendDates.size * rules.weekend_pa_credit +
        a.uExtraSessions / sessionsPerPa,
    );
    const recordedPas = round2(a.recordedPas);
    out.push({
      staffId,
      sessions: a.sessions,
      recordedPas,
      estimatedPas,
      totalPas: round2(recordedPas + estimatedPas),
      gapSessions: a.gapSessions,
      gapDates: [...a.gapDates].sort(),
    });
  }

  return out.sort(
    (a, b) => b.totalPas - a.totalPas || a.staffId.localeCompare(b.staffId),
  );
}
