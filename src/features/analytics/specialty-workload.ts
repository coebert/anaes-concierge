// Pure helpers for the "Clinical work by specialty" audit page.
//
// This generalises the ICU audit (see icu-workload.ts) to every kind of
// clinical work recorded on CLWRota, so a doctor can evidence their whole
// job plan — theatre lists by surgical specialty, obstetrics, intensive
// care, on-calls, teaching, SPA and admin — not just intensive care.
//
// Counting rules match the ICU audit exactly:
//   - `am` / `pm` halves are daytime sessions; `eve` / `night` are on-call,
//     and several on-call halves on one date collapse to a single on-call.
//   - A "day worked" is a distinct date with at least one daytime session.
//   - Weekend credit REPLACES session / on-call credit (never stacks).
//   - Rows tagged `extra_type` (extra / locum / WLI / SAG) are excluded from
//     job-planned totals and reported separately.
//   - CLWRota's own `pa_credit` is used where present; anything else is
//     estimated from the department rota rules.

import {
  creditedStaffIds,
  isDaytimeHalf,
  isExtraRow,
  isOnCallHalf,
  isWeekendISO,
  type IcuPaRules,
  type IcuRow,
} from "./icu-workload";

export type SpecialtyPaRules = IcuPaRules;

export type SpecialtyRow = IcuRow & {
  /** Surgical/clinical specialty attached to the theatre session, if any. */
  specialty_name?: string | null;
};

/** Human labels for non-theatre duty types. */
export const DUTY_AREA_LABELS: Record<string, string> = {
  theatre: "Theatre (unspecified specialty)",
  consultant_in_charge: "Consultant in charge",
  obstetrics: "Obstetrics",
  obstetrics_2nd: "Obstetrics (second on)",
  icu_trainee: "Intensive care",
  icu_ct2_plus: "Intensive care",
  icu_consultant_oncall: "Intensive care",
  general_consultant_oncall: "General on-call",
  registrar_oncall: "Registrar on-call",
  sho_oncall: "SHO on-call",
  nhh_oncall: "NHH on-call",
  spa: "SPA",
  admin: "Admin",
  teaching: "Teaching",
  non_clinical: "Non-clinical",
  medical_examiner: "Medical examiner",
};

/**
 * The clinical area a rota row belongs to: the theatre list's specialty when
 * there is one, otherwise a label derived from the duty type.
 */
export function areaForRow(row: SpecialtyRow): string {
  const duty = row.duty_type ?? "";
  const specialty = (row.specialty_name ?? "").trim();
  if (specialty) return specialty;
  return DUTY_AREA_LABELS[duty] ?? (duty ? duty.replace(/_/g, " ") : "Unclassified");
}

/** True when the area represents theatre/clinical list work rather than a duty. */
export function isClinicalRow(row: SpecialtyRow): boolean {
  return row.duty_type !== "non_clinical";
}

export type SpecialtyTally = {
  staff_id: string;
  area: string;
  days: number;
  sessions: number;
  onCalls: number;
  weekendDays: number;
  extraSessions: number;
  plannedPas: number;
  extraPas: number;
  totalPas: number;
  clwrotaPas: number;
  estimatedPas: number;
  dates: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Acc = {
  dayDates: Set<string>;
  onCallDates: Set<string>;
  weekendDates: Set<string>;
  allDates: Set<string>;
  sessions: number;
  extraSessions: number;
  storedPa: number;
  storedExtraPa: number;
  uSessions: number;
  uOnCallDates: Set<string>;
  uWeekendDates: Set<string>;
  uExtraSessions: number;
};

function newAcc(): Acc {
  return {
    dayDates: new Set(),
    onCallDates: new Set(),
    weekendDates: new Set(),
    allDates: new Set(),
    sessions: 0,
    extraSessions: 0,
    storedPa: 0,
    storedExtraPa: 0,
    uSessions: 0,
    uOnCallDates: new Set(),
    uWeekendDates: new Set(),
    uExtraSessions: 0,
  };
}

/**
 * Tally every clinical area per staff member, converting sessions into PAs
 * with the department rota rules.
 */
export function tallySpecialtyWorkload(
  rows: readonly SpecialtyRow[],
  rules: SpecialtyPaRules,
): SpecialtyTally[] {
  const sessionsPerPa = rules.sessions_per_pa > 0 ? rules.sessions_per_pa : 1;
  const byKey = new Map<string, { staff_id: string; area: string; acc: Acc }>();

  for (const r of rows) {
    if (!r.staff_id || !r.session_date) continue;
    if (!isDaytimeHalf(r.session) && !isOnCallHalf(r.session)) continue;

    const area = areaForRow(r);
    const credited = creditedStaffIds(r);
    const stored = typeof r.pa_credit === "number" && Number.isFinite(r.pa_credit);

    for (const id of credited) {
      const key = `${id}::${area}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { staff_id: id, area, acc: newAcc() };
        byKey.set(key, entry);
      }
      const a = entry.acc;
      a.allDates.add(r.session_date);

      if (isExtraRow(r)) {
        a.extraSessions += 1;
        if (stored) a.storedExtraPa += r.pa_credit as number;
        else a.uExtraSessions += 1;
        continue;
      }

      const weekend = isWeekendISO(r.session_date);
      if (isDaytimeHalf(r.session)) {
        a.dayDates.add(r.session_date);
        a.sessions += 1;
        if (stored) a.storedPa += r.pa_credit as number;
        else if (!weekend) a.uSessions += 1;
      } else {
        a.onCallDates.add(r.session_date);
        if (stored) a.storedPa += r.pa_credit as number;
        else if (!weekend) a.uOnCallDates.add(r.session_date);
      }

      if (weekend) {
        a.weekendDates.add(r.session_date);
        if (!stored) a.uWeekendDates.add(r.session_date);
      }
    }
  }

  const out: SpecialtyTally[] = [];
  for (const { staff_id, area, acc: a } of byKey.values()) {
    const plannedPas = round2(
      a.storedPa +
        a.uSessions / sessionsPerPa +
        a.uOnCallDates.size * rules.oncall_pa_credit +
        a.uWeekendDates.size * rules.weekend_pa_credit,
    );
    const extraPas = round2(a.storedExtraPa + a.uExtraSessions / sessionsPerPa);
    const totalPas = round2(plannedPas + extraPas);
    const clwrotaPas = round2(a.storedPa + a.storedExtraPa);

    out.push({
      staff_id,
      area,
      days: a.dayDates.size,
      sessions: a.sessions,
      onCalls: a.onCallDates.size,
      weekendDays: a.weekendDates.size,
      extraSessions: a.extraSessions,
      plannedPas,
      extraPas,
      totalPas,
      clwrotaPas,
      estimatedPas: round2(totalPas - clwrotaPas),
      dates: Array.from(a.allDates).sort(),
    });
  }

  return out
    .filter((t) => t.days > 0 || t.onCalls > 0 || t.extraSessions > 0)
    .sort(
      (a, b) =>
        b.totalPas - a.totalPas ||
        a.area.localeCompare(b.area) ||
        a.staff_id.localeCompare(b.staff_id),
    );
}

export type AreaSummary = {
  area: string;
  doctors: number;
  days: number;
  sessions: number;
  onCalls: number;
  totalPas: number;
};

/** Roll the per-doctor tallies up into one row per clinical area. */
export function summariseByArea(tallies: readonly SpecialtyTally[]): AreaSummary[] {
  const byArea = new Map<string, AreaSummary & { ids: Set<string> }>();
  for (const t of tallies) {
    let s = byArea.get(t.area);
    if (!s) {
      s = { area: t.area, doctors: 0, days: 0, sessions: 0, onCalls: 0, totalPas: 0, ids: new Set() };
      byArea.set(t.area, s);
    }
    s.ids.add(t.staff_id);
    s.days += t.days;
    s.sessions += t.sessions;
    s.onCalls += t.onCalls;
    s.totalPas = round2(s.totalPas + t.totalPas);
  }
  return Array.from(byArea.values())
    .map(({ ids, ...rest }) => ({ ...rest, doctors: ids.size }))
    .sort((a, b) => b.totalPas - a.totalPas || a.area.localeCompare(b.area));
}

export type SpecialtySession = {
  staff_id: string;
  area: string;
  date: string;
  session: string;
  isOnCall: boolean;
  isWeekend: boolean;
  extraType: string | null;
  /** PA value recorded by CLWRota, or null when it has to be estimated. */
  recordedPa: number | null;
  /** PA credited for this row (recorded value, or the rules-derived estimate). */
  creditedPa: number;
  /** Other doctors named on the same CLWRota row. */
  sharedWith: string[];
};

/**
 * Session-level rows for the per-specialty audit, so every credited PA can be
 * traced back to the date and half it came from.
 *
 * Weekend credit replaces session/on-call credit, and only the first on-call
 * half of a weekend/weekday date carries the credit — matching the totals in
 * `tallySpecialtyWorkload`.
 */
export function listSpecialtySessions(
  rows: readonly SpecialtyRow[],
  rules: SpecialtyPaRules,
): SpecialtySession[] {
  const sessionsPerPa = rules.sessions_per_pa > 0 ? rules.sessions_per_pa : 1;
  const creditedOnCall = new Set<string>();
  const creditedWeekend = new Set<string>();
  const out: SpecialtySession[] = [];

  const ordered = [...rows]
    .filter((r) => r.staff_id && r.session_date)
    .sort(
      (a, b) =>
        (a.session_date ?? "").localeCompare(b.session_date ?? "") ||
        (a.session ?? "").localeCompare(b.session ?? ""),
    );

  for (const r of ordered) {
    if (!isDaytimeHalf(r.session) && !isOnCallHalf(r.session)) continue;
    const date = r.session_date as string;
    const area = areaForRow(r);
    const onCall = isOnCallHalf(r.session);
    const weekend = isWeekendISO(date);
    const extra = isExtraRow(r);
    const stored =
      typeof r.pa_credit === "number" && Number.isFinite(r.pa_credit) ? r.pa_credit : null;

    const credited = creditedStaffIds(r);

    for (const id of credited) {
      let creditedPa: number;
      if (stored !== null) {
        creditedPa = stored;
      } else if (extra) {
        creditedPa = 1 / sessionsPerPa;
      } else if (weekend) {
        const key = `${id}::${area}::${date}`;
        creditedPa = creditedWeekend.has(key) ? 0 : rules.weekend_pa_credit;
        creditedWeekend.add(key);
      } else if (onCall) {
        const key = `${id}::${area}::${date}`;
        creditedPa = creditedOnCall.has(key) ? 0 : rules.oncall_pa_credit;
        creditedOnCall.add(key);
      } else {
        creditedPa = 1 / sessionsPerPa;
      }

      out.push({
        staff_id: id,
        area,
        date,
        session: r.session ?? "",
        isOnCall: onCall,
        isWeekend: weekend,
        extraType: r.extra_type ?? null,
        recordedPa: stored,
        creditedPa: round2(creditedPa),
        sharedWith: credited.filter((other) => other !== id),
      });
    }
  }

  return out;
}
