/**
 * "My practice summary" — one clinician's own rota-derived activity for a date
 * range, for appraisal evidence.
 *
 * Pure: the server function loads the caller's own rows and calls this. All
 * counting rules are reused, not re-implemented:
 *   - areas, days, sessions, on-calls, weekend days and PAs come from
 *     `tallySpecialtyWorkload` (the same rule set as the appraisal-year,
 *     specialty and ICU audits: CLWRota PA where recorded, otherwise the
 *     department rota rules; weekend credit replaces session credit; extra /
 *     locum / WLI / SAG rows reported separately);
 *   - who is credited for a row is `creditedStaffIds` (the rostered person
 *     plus any consultant/SAS named on the row);
 *   - day/on-call halves are `isDaytimeHalf` / `isOnCallHalf`.
 *
 * Output is aggregate only: no other clinician's id or name, no surgeon names,
 * no notes, no patient data. Everything here is ROSTERED work as recorded on
 * CLWRota — the app holds no evidence that a session was delivered, and no
 * case numbers, outcomes or competence.
 */
import {
  creditedStaffIds,
  ICU_DUTY_TYPES,
  isDaytimeHalf,
  isExtraRow,
  isOnCallHalf,
  isWeekendISO,
} from "@/features/analytics/icu-workload";
import {
  tallySpecialtyWorkload,
  type SpecialtyPaRules,
  type SpecialtyRow,
} from "@/features/analytics/specialty-workload";

import type { PracticeLeaveSummary } from "./leave-summary";

export const MAX_RANGE_DAYS = 400;

export interface PracticeRow {
  id: string;
  staff_id: string | null;
  session_date: string | null;
  session: string | null;
  duty_type: string | null;
  extra_type: string | null;
  pa_credit: number | null;
  attending_consultant_ids: string[] | null;
  theatre_session_id: string | null;
  source: string | null;
  locally_modified: boolean | null;
  clwrota_external_id: string | null;
}

export interface ListInfo {
  specialty: string | null;
  location: string | null;
}

/** Week publication status as observed by the import (see rota-week-status). */
export type WeekPublication =
  | "published"
  | "setup"
  | "not_setup"
  | "mixed"
  | "unknown"
  | "other"
  | "not_observed";
/** Per-week import coverage state (see rota-sync-coverage). */
export type WeekImport =
  | "current"
  | "stale"
  | "incomplete"
  | "attempt_problem"
  | "not_tracked"
  | "before_tracking";

export type DutyGroup =
  | "Theatre lists"
  | "Obstetrics"
  | "Intensive care"
  | "On-call duty"
  | "Consultant in charge"
  | "Teaching"
  | "Medical examiner"
  | "SPA"
  | "Admin"
  | "Non-clinical"
  | "Other";

export const DUTY_GROUP_ORDER: DutyGroup[] = [
  "Theatre lists",
  "Obstetrics",
  "Intensive care",
  "On-call duty",
  "Consultant in charge",
  "Teaching",
  "Medical examiner",
  "SPA",
  "Admin",
  "Non-clinical",
  "Other",
];

const ICU = new Set<string>(ICU_DUTY_TYPES);
export function dutyGroupOf(duty: string | null): DutyGroup {
  const d = duty ?? "";
  if (d === "theatre") return "Theatre lists";
  if (d === "obstetrics" || d === "obstetrics_2nd") return "Obstetrics";
  if (ICU.has(d)) return "Intensive care";
  if (["general_consultant_oncall", "registrar_oncall", "sho_oncall", "nhh_oncall"].includes(d))
    return "On-call duty";
  if (d === "consultant_in_charge") return "Consultant in charge";
  if (d === "teaching") return "Teaching";
  if (d === "medical_examiner") return "Medical examiner";
  if (d === "spa") return "SPA";
  if (d === "admin") return "Admin";
  if (d === "non_clinical") return "Non-clinical";
  return "Other";
}

type Halves = { am: number; pm: number; eve: number; night: number };
const zeroHalves = (): Halves => ({ am: 0, pm: 0, eve: 0, night: 0 });

export interface AreaLine {
  area: string;
  days: number;
  sessions: number;
  onCalls: number;
  weekendDays: number;
  extraSessions: number;
  totalPas: number;
  clwrotaPas: number;
  estimatedPas: number;
}

export interface MonthLine {
  month: string;
  entries: number;
  daytimeSessions: number;
  onCallDates: number;
  icuEntries: number;
  totalPas: number;
  estimatedPas: number;
}

export interface PracticeSummary {
  from: string;
  to: string;
  today: string;
  scope: {
    /** Entries rostered to you. */
    rosteredEntries: number;
    /** Entries rostered to another doctor that name you as attending consultant. */
    namedOnOtherEntries: number;
    /** Distinct date + half-day with at least one entry credited to you. */
    distinctHalfDays: number;
    distinctDays: number;
    /** Half-days credited to you by more than one entry. */
    halfDaysWithSeveralEntries: number;
    /** Entries that are one half of an all-day CLWRota row split into AM and PM. */
    splitAllDayEntries: number;
    pastEntries: number;
    futureEntries: number;
  };
  totals: {
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
  };
  areas: AreaLine[];
  dutyGroups: Array<{ group: DutyGroup; entries: number; halves: Halves; extraEntries: number }>;
  locations: Array<{ location: string; entries: number }>;
  onCall: {
    onCallDates: number;
    weekendOnCallDates: number;
    byDuty: Array<{ group: DutyGroup; dates: number }>;
    daytimeOnCallDutyEntries: number;
  };
  icu: { entries: number; daytimeSessions: number; onCallDates: number } | null;
  obstetrics: { entries: number; daytimeSessions: number; onCallDates: number } | null;
  teaching: { entries: number; daytimeSessions: number } | null;
  months: MonthLine[];
  coverage: {
    byPublication: Partial<Record<WeekPublication, number>>;
    byImport: Partial<Record<WeekImport, number>>;
    weeksInRange: number;
  };
  quality: {
    theatreNotLinkedToList: number;
    listWithoutSpecialty: number;
    estimatedPaEntries: number;
    locallyEditedEntries: number;
    enteredInApp: number;
    unknownHalfExcluded: number;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function isValidRange(from: string, to: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return false;
  return (b - a) / 86_400_000 + 1 <= MAX_RANGE_DAYS;
}

/**
 * Report-wide "days with daytime work": distinct dates with at least one AM/PM
 * entry credited to the caller (the report's definition of a day — extra /
 * locum / WLI / SAG sessions included, evening/night excluded). Summing each
 * specialty's own day count counted a date once per specialty worked that day.
 */
export function distinctDaytimeWorkDates(rows: readonly SpecialtyRow[], userId: string): number {
  const dates = new Set<string>();
  for (const r of rows) {
    if (!r.staff_id || !r.session_date || !isDaytimeHalf(r.session)) continue;
    if (!creditedStaffIds(r).includes(userId)) continue;
    dates.add(r.session_date);
  }
  return dates.size;
}

function sumTallies(rows: SpecialtyRow[], userId: string, rules: SpecialtyPaRules) {
  const t = tallySpecialtyWorkload(rows, rules).filter((x) => x.staff_id === userId);
  const days = distinctDaytimeWorkDates(rows, userId);
  return {
    tallies: t,
    totals: t.reduce(
      (acc, x) => ({
        days,
        sessions: acc.sessions + x.sessions,
        onCalls: acc.onCalls + x.onCalls,
        weekendDays: acc.weekendDays + x.weekendDays,
        extraSessions: acc.extraSessions + x.extraSessions,
        plannedPas: round2(acc.plannedPas + x.plannedPas),
        extraPas: round2(acc.extraPas + x.extraPas),
        totalPas: round2(acc.totalPas + x.totalPas),
        clwrotaPas: round2(acc.clwrotaPas + x.clwrotaPas),
        estimatedPas: round2(acc.estimatedPas + x.estimatedPas),
      }),
      {
        days,
        sessions: 0,
        onCalls: 0,
        weekendDays: 0,
        extraSessions: 0,
        plannedPas: 0,
        extraPas: 0,
        totalPas: 0,
        clwrotaPas: 0,
        estimatedPas: 0,
      },
    ),
  };
}

export function buildPracticeSummary(input: {
  userId: string;
  from: string;
  to: string;
  today: string;
  rows: readonly PracticeRow[];
  lists: ReadonlyMap<string, ListInfo>;
  rules: SpecialtyPaRules;
  weekPublication: ReadonlyMap<string, WeekPublication>;
  weekImport: ReadonlyMap<string, WeekImport>;
}): PracticeSummary {
  const { userId, from, to, today, rules } = input;
  // Only rows in range that credit the caller — anything else is ignored,
  // whatever the loader returned.
  const mine = input.rows.filter(
    (r) =>
      r.session_date &&
      r.session_date >= from &&
      r.session_date <= to &&
      creditedStaffIds(r).includes(userId),
  );
  const unknownHalf = mine.filter((r) => !isDaytimeHalf(r.session) && !isOnCallHalf(r.session));
  const counted = mine.filter((r) => isDaytimeHalf(r.session) || isOnCallHalf(r.session));

  const asSpecialty = (r: PracticeRow): SpecialtyRow => ({
    staff_id: r.staff_id,
    session_date: r.session_date,
    session: r.session,
    duty_type: r.duty_type,
    extra_type: r.extra_type,
    pa_credit: r.pa_credit,
    attending_consultant_ids: r.attending_consultant_ids,
    specialty_name: r.theatre_session_id
      ? (input.lists.get(r.theatre_session_id)?.specialty ?? null)
      : null,
  });
  const specialtyRows = counted.map(asSpecialty);
  const { tallies, totals } = sumTallies(specialtyRows, userId, rules);

  // Scope
  const halfCount = new Map<string, number>();
  const days = new Set<string>();
  for (const r of counted) {
    const k = `${r.session_date}|${r.session}`;
    halfCount.set(k, (halfCount.get(k) ?? 0) + 1);
    days.add(r.session_date!);
  }
  const isSplit = (r: PracticeRow) =>
    !!r.clwrota_external_id &&
    r.clwrota_external_id.split("|").length === 4 &&
    /\|(am|pm|eve|night)$/.test(r.clwrota_external_id);

  // Duty groups + halves
  const groups = new Map<DutyGroup, { entries: number; halves: Halves; extraEntries: number }>();
  for (const r of counted) {
    const g = dutyGroupOf(r.duty_type);
    const e = groups.get(g) ?? { entries: 0, halves: zeroHalves(), extraEntries: 0 };
    e.entries += 1;
    e.halves[r.session as keyof Halves] += 1;
    if (isExtraRow(r)) e.extraEntries += 1;
    groups.set(g, e);
  }

  // Locations (theatre rooms of linked lists only)
  const loc = new Map<string, number>();
  for (const r of counted) {
    if (!r.theatre_session_id) continue;
    const l = input.lists.get(r.theatre_session_id)?.location;
    if (!l) continue;
    loc.set(l, (loc.get(l) ?? 0) + 1);
  }

  // On-call (existing rule: eve/night halves; several halves on one date = one on-call)
  const onCallDates = new Set<string>();
  const weekendOnCall = new Set<string>();
  const onCallByGroup = new Map<DutyGroup, Set<string>>();
  let daytimeOnCallDuty = 0;
  for (const r of counted) {
    if (isOnCallHalf(r.session)) {
      onCallDates.add(r.session_date!);
      if (isWeekendISO(r.session_date!)) weekendOnCall.add(r.session_date!);
      const g = dutyGroupOf(r.duty_type);
      const s = onCallByGroup.get(g) ?? new Set<string>();
      s.add(r.session_date!);
      onCallByGroup.set(g, s);
    } else if (dutyGroupOf(r.duty_type) === "On-call duty") {
      daytimeOnCallDuty += 1;
    }
  }

  const section = (g: DutyGroup) => {
    const rs = counted.filter((r) => dutyGroupOf(r.duty_type) === g);
    if (rs.length === 0) return null;
    return {
      entries: rs.length,
      daytimeSessions: rs.filter((r) => isDaytimeHalf(r.session)).length,
      onCallDates: new Set(rs.filter((r) => isOnCallHalf(r.session)).map((r) => r.session_date))
        .size,
    };
  };
  const teach = section("Teaching");

  // Months — PAs per month from the same tally rule on that month's rows.
  const months: MonthLine[] = monthsBetween(from, to).map((month) => {
    const rs = counted.filter((r) => r.session_date!.startsWith(month));
    const t = sumTallies(rs.map(asSpecialty), userId, rules).totals;
    return {
      month,
      entries: rs.length,
      daytimeSessions: rs.filter((r) => isDaytimeHalf(r.session)).length,
      onCallDates: new Set(rs.filter((r) => isOnCallHalf(r.session)).map((r) => r.session_date))
        .size,
      icuEntries: rs.filter((r) => dutyGroupOf(r.duty_type) === "Intensive care").length,
      totalPas: t.totalPas,
      estimatedPas: t.estimatedPas,
    };
  });

  // Coverage — each counted entry by the status of its week.
  const byPublication: Partial<Record<WeekPublication, number>> = {};
  const byImport: Partial<Record<WeekImport, number>> = {};
  for (const r of counted) {
    const w = weekStartOf(r.session_date!);
    const p = input.weekPublication.get(w) ?? "not_observed";
    byPublication[p] = (byPublication[p] ?? 0) + 1;
    const i = input.weekImport.get(w) ?? "not_tracked";
    byImport[i] = (byImport[i] ?? 0) + 1;
  }
  const weeks = new Set<string>();
  for (
    let w = weekStartOf(from);
    w <= to;
    w = new Date(Date.parse(`${w}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
  )
    weeks.add(w);

  return {
    from,
    to,
    today,
    scope: {
      rosteredEntries: counted.filter((r) => r.staff_id === userId).length,
      namedOnOtherEntries: counted.filter((r) => r.staff_id !== userId).length,
      distinctHalfDays: halfCount.size,
      distinctDays: days.size,
      halfDaysWithSeveralEntries: [...halfCount.values()].filter((n) => n > 1).length,
      splitAllDayEntries: counted.filter(isSplit).length,
      pastEntries: counted.filter((r) => r.session_date! <= today).length,
      futureEntries: counted.filter((r) => r.session_date! > today).length,
    },
    totals,
    areas: tallies.map((t) => ({
      area: t.area,
      days: t.days,
      sessions: t.sessions,
      onCalls: t.onCalls,
      weekendDays: t.weekendDays,
      extraSessions: t.extraSessions,
      totalPas: t.totalPas,
      clwrotaPas: t.clwrotaPas,
      estimatedPas: t.estimatedPas,
    })),
    dutyGroups: DUTY_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({
      group: g,
      ...groups.get(g)!,
    })),
    locations: [...loc.entries()]
      .map(([location, entries]) => ({ location, entries }))
      .sort((a, b) => b.entries - a.entries || a.location.localeCompare(b.location)),
    onCall: {
      onCallDates: onCallDates.size,
      weekendOnCallDates: weekendOnCall.size,
      byDuty: DUTY_GROUP_ORDER.filter((g) => onCallByGroup.has(g)).map((g) => ({
        group: g,
        dates: onCallByGroup.get(g)!.size,
      })),
      daytimeOnCallDutyEntries: daytimeOnCallDuty,
    },
    icu: section("Intensive care"),
    obstetrics: section("Obstetrics"),
    teaching: teach ? { entries: teach.entries, daytimeSessions: teach.daytimeSessions } : null,
    months,
    coverage: { byPublication, byImport, weeksInRange: weeks.size },
    quality: {
      theatreNotLinkedToList: counted.filter(
        (r) => r.duty_type === "theatre" && !r.theatre_session_id,
      ).length,
      listWithoutSpecialty: counted.filter(
        (r) => r.theatre_session_id && !input.lists.get(r.theatre_session_id)?.specialty,
      ).length,
      estimatedPaEntries: counted.filter(
        (r) => !(typeof r.pa_credit === "number" && Number.isFinite(r.pa_credit)) && !isExtraRow(r),
      ).length,
      locallyEditedEntries: counted.filter((r) => r.locally_modified).length,
      enteredInApp: counted.filter((r) => r.source !== "clwrota").length,
      unknownHalfExcluded: unknownHalf.length,
    },
  };
}

/** Aggregate-only CSV (section,item,measure,value). No identifiers or free text from the rota. */
export function practiceSummaryCsv(
  s: PracticeSummary,
  meta: { generatedAt: string; leave?: PracticeLeaveSummary },
): string {
  const lines: string[][] = [["section", "item", "measure", "value"]];
  const add = (section: string, item: string, measure: string, value: string | number) =>
    lines.push([section, item, measure, String(value)]);
  add("report", "range", "from", s.from);
  add("report", "range", "to", s.to);
  add("report", "generated", "at", meta.generatedAt);
  add(
    "report",
    "basis",
    "note",
    "Rostered CLWRota entries; not evidence of delivered work, cases or outcomes",
  );
  for (const [k, v] of Object.entries(s.scope)) add("scope", "all", k, v);
  for (const [k, v] of Object.entries(s.totals)) add("totals", "all", k, v);
  for (const a of s.areas)
    for (const [k, v] of Object.entries(a)) if (k !== "area") add("area", a.area, k, v as number);
  for (const g of s.dutyGroups) {
    add("duty", g.group, "entries", g.entries);
    for (const [h, n] of Object.entries(g.halves)) add("duty", g.group, `${h}_entries`, n);
    add("duty", g.group, "extra_entries", g.extraEntries);
  }
  for (const l of s.locations) add("location", l.location, "entries", l.entries);
  add("on_call", "all", "on_call_dates", s.onCall.onCallDates);
  add("on_call", "all", "weekend_on_call_dates", s.onCall.weekendOnCallDates);
  add("on_call", "all", "daytime_on_call_duty_entries", s.onCall.daytimeOnCallDutyEntries);
  for (const b of s.onCall.byDuty) add("on_call", b.group, "dates", b.dates);
  for (const m of s.months)
    for (const [k, v] of Object.entries(m))
      if (k !== "month") add("month", m.month, k, v as number);
  for (const [k, v] of Object.entries(s.coverage.byPublication))
    add("coverage", "week_publication", k, v as number);
  for (const [k, v] of Object.entries(s.coverage.byImport))
    add("coverage", "week_import", k, v as number);
  add("coverage", "weeks", "in_range", s.coverage.weeksInRange);
  for (const [k, v] of Object.entries(s.quality)) add("data_quality", "all", k, v);
  if (meta.leave) {
    const l = meta.leave;
    for (const t of l.byType) {
      add("leave", t.type, "approved_requests", t.requests);
      add("leave", t.type, "working_days", t.workingDays);
      add("leave", t.type, "working_days_still_to_come", t.plannedWorkingDays);
    }
    add("leave", "all", "approved_requests", l.approvedRequests);
    add("leave", "all", "working_days", l.workingDays);
    add("leave", "all", "working_days_still_to_come", l.plannedWorkingDays);
    add("leave", "all", "pending_requests_not_counted", l.pendingRequests);
    add("leave", "all", "rejected_or_cancelled_not_counted", l.notTakenRequests);
  }
  const esc = (v: string) => {
    // Neutralise spreadsheet formula injection and quote every cell.
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return lines.map((l) => l.map(esc).join(",")).join("\r\n") + "\r\n";
}
