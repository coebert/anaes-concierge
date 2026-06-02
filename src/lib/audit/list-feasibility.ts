/**
 * List-feasibility model.
 *
 * Looks at the last N months of CLWRota actuals to identify recurring
 * surgical lists (by day-of-week + session + theatre + surgeon) and asks:
 * if we assigned a single named anaesthetic consultant as the regular
 * owner of each such list, would the current consultant pool actually
 * make that work — given observed leave, on-call, SPA and other duties?
 *
 * The feasibility bar is configurable along three axes:
 *  - ownerPresentMinPct      — owner alone covers ≥ X% of their list
 *  - ownerOrDeputyMinPct     — owner OR named deputy covers ≥ Y%
 *  - forbidNewShortfalls     — locking the owner mustn't tip the day into
 *                              the existing robustness "shortfall" state
 *
 * The output is a per-list verdict (feasible / borderline / not feasible)
 * with a rough headcount-gap estimate, plus a department-wide rollup.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Grade } from "./robustness";

// -------- public types --------

export interface FeasibilityThresholds {
  ownerPresentMinPct: number;   // 0-100
  ownerOrDeputyMinPct: number;  // 0-100
  forbidNewShortfalls: boolean;
  /** Minimum occurrences in window for a slot to be considered "regular". */
  minOccurrences: number;
  /** % of active consultants with any duty record above which a day is "thin". 0-100. */
  shortfallDayBusyPct: number;
  /** WTE added per failed slot dimension (rough PA→WTE conversion). */
  wtePerWeeklySession: number;
  /** % of eligible (dow, session) instances a consultant must work (excluding
   *  on-call days they were rostered for) before that half-day counts as part
   *  of their regular working pattern. 0-100. */
  regularWorkingMinPct: number;
}

export const DEFAULT_THRESHOLDS: FeasibilityThresholds = {
  ownerPresentMinPct: 80,
  ownerOrDeputyMinPct: 95,
  forbidNewShortfalls: true,
  minOccurrences: 4,
  shortfallDayBusyPct: 70,
  wtePerWeeklySession: 0.1,
  regularWorkingMinPct: 50,
};


export type Verdict = "feasible" | "borderline" | "not_feasible";

export interface CandidateOwner {
  id: string;
  name: string;
  /** % of eligible (dow, session) instances they actually worked (non-on-call). */
  workingPct: number;
  /** True if they already happen to be the proposed owner or deputy. */
  isCurrentOwner: boolean;
  isCurrentDeputy: boolean;
}

export interface ListSlotFeasibility {
  key: string;
  dow: number;                  // 1=Mon ... 5=Fri
  session: "am" | "pm";
  theatreId: string;
  theatreName: string;
  surgeon: string;              // normalised display name
  occurrences: number;
  /** Top consultant by frequency on this slot. May be null if no consultant ever covered it. */
  ownerId: string | null;
  ownerName: string | null;
  ownerCovered: number;
  ownerPresentPct: number;
  /** 2nd-most frequent consultant. */
  deputyId: string | null;
  deputyName: string | null;
  deputyCovered: number;
  ownerOrDeputyPct: number;
  /** Sessions where owner was absent due to leave/on-call/SPA/other duty. */
  ownerUnavailable: number;
  /** Sessions where owner was free (not assigned anywhere) but someone else covered. */
  ownerFreeButReplaced: number;
  /** Sessions where, if the owner had been locked here, the day would have flipped to shortfall. */
  shortfallsIfLocked: number;
  verdict: Verdict;
  /** Rough additional WTE needed to make this slot feasible at chosen threshold. */
  headcountGap: number;
  reasons: string[];
  /** Consultants whose regular weekly working pattern includes this (dow, session)
   *  and who could therefore plausibly take this slot on. Sorted by working %.
   *  Includes the current proposed owner/deputy if they qualify. */
  candidateOwners: CandidateOwner[];
}

export interface ConsultantPatternCell {
  dow: number;            // 1-5
  session: "am" | "pm";
  /** Total weekdays of this dow within this consultant's personal tenure
   *  (intersection of the data window and dates they actually appear in
   *  the rota). NOT reduced by on-call. */
  totalOccurrences: number;
  /** Times this consultant was on-call on that half (informational only). */
  oncallOccurrences: number;
  /** Times this consultant was assigned to clinical activity (theatre list) on that half. */
  workingOccurrences: number;
  /** workingOccurrences / max(1, totalOccurrences) as a percentage. */
  workingPct: number;
  /** True if workingPct ≥ thresholds.regularWorkingMinPct. */
  regular: boolean;
  /** True if this dow is a regular non-working day for this consultant —
   *  either via profiles.ltft_days_off or inferred from a tenure with
   *  meaningful exposure but zero rota records of any duty type on this dow.
   *  Excluded from totalOccurrences so they aren't counted as "available". */
  regularDayOff: boolean;
}

export interface ConsultantPattern {
  id: string;
  name: string;
  /** 10 cells, Mon-Fri × AM/PM, always in order Mon AM, Mon PM, Tue AM … Fri PM. */
  cells: ConsultantPatternCell[];
  /** Count of cells with regular === true. */
  regularSessionsPerWeek: number;
  /** First date in the window this consultant appears in the rota at all. */
  tenureStart: string | null;
  /** Last date in the window this consultant appears in the rota at all. */
  tenureEnd: string | null;
  /** Mon–Fri weekdays between tenureStart and tenureEnd inclusive. */
  tenureWeekdays: number;
}

export interface DepartmentSummary {
  windowStart: string;
  windowEnd: string;
  thresholds: FeasibilityThresholds;
  totalSlots: number;
  feasible: number;
  borderline: number;
  notFeasible: number;
  /** Sum of per-slot headcount gaps, weighted by sessions/week → consultant WTE. */
  estimatedExtraWte: number;
  /** Data-quality: how many theatre rota_assignments in the window are linked
   *  to a theatre_session via theatre_session_id (the only way to attribute a
   *  consultant to a specific list). Coverage % below is computed on the
   *  linked subset; unlinked rows are used only to detect "owner busy on
   *  another list" so they aren't mis-classified as free. */
  theatreAssignmentsTotal: number;
  theatreAssignmentsLinked: number;
}

export interface ListFeasibilityResult {
  summary: DepartmentSummary;
  slots: ListSlotFeasibility[];
  /** One row per active consultant, with their working pattern matrix. */
  consultantPatterns: ConsultantPattern[];
}


// -------- helpers --------

function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function normaliseSurgeon(name: string | null | undefined): string {
  if (!name) return "(unknown surgeon)";
  return name
    .replace(/\s+/g, " ")
    .replace(/^(mr|mrs|ms|miss|dr|prof|professor)\.?\s+/i, "")
    .trim()
    .toLowerCase();
}

function displaySurgeon(raw: string | null | undefined): string {
  if (!raw) return "(unknown)";
  return raw.replace(/\s+/g, " ").trim();
}

function classify(
  pct: number,
  thresholdPct: number,
): "above" | "near" | "below" {
  if (pct >= thresholdPct) return "above";
  if (pct >= thresholdPct - 10) return "near";
  return "below";
}

const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// -------- core compute --------

export interface ComputeOptions {
  /** How far back to look at actuals. Defaults to 6 months. */
  monthsBack?: number;
  thresholds?: Partial<FeasibilityThresholds>;
  /** Override clock for tests. */
  todayOverride?: string;
}

export async function computeListFeasibility(
  opts: ComputeOptions = {},
): Promise<ListFeasibilityResult> {
  const monthsBack = opts.monthsBack ?? 6;
  const thresholds: FeasibilityThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(opts.thresholds ?? {}),
  };
  const windowEnd = opts.todayOverride ?? todayISO();
  const windowStart = (() => {
    const d = new Date(windowEnd + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() - monthsBack);
    return d.toISOString().slice(0, 10);
  })();
  void isoMonthsAgo;

  const [profiles, theatres, specialties, sessions, assignments] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("profiles")
        .select("id, full_name, grade, active, ltft_days_off")
        .order("full_name", { nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("theatres")
        .select("id, name")
        .order("name", { nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("specialties")
        .select("id, name")
        .order("name", { nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("theatre_sessions")
        .select("id, session_date, session, theatre_id, surgical_consultant, specialty_id")
        .gte("session_date", windowStart)
        .lte("session_date", windowEnd)
        .order("session_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("rota_assignments")
        .select("staff_id, session_date, session, duty_type, role_on_list, theatre_session_id")
        .gte("session_date", windowStart)
        .lte("session_date", windowEnd)
        .order("session_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // Specialty IDs that represent emergency / unscheduled work. These lists
  // are not regular bookings and shouldn't be expected to have a fixed
  // anaesthetic consultant owner — exclude them from the feasibility model.
  const emergencySpecialtyIds = new Set<string>();
  for (const sp of specialties ?? []) {
    const n = ((sp.name as string) || "").toLowerCase();
    if (/emerg|cepod/.test(n)) emergencySpecialtyIds.add(sp.id as string);
  }
  const isEmergencySession = (
    specialtyId: string | null,
    surgeonRaw: string,
  ): boolean => {
    if (specialtyId && emergencySpecialtyIds.has(specialtyId)) return true;
    return /\b(emergency|cepod)\b/i.test(surgeonRaw);
  };

  const consultantById = new Map<
    string,
    { id: string; name: string; active: boolean; ltftDaysOff: Set<number> }
  >();
  for (const p of profiles ?? []) {
    if ((p.grade as Grade) === "consultant") {
      const raw = (p.ltft_days_off as unknown as number[] | null) ?? [];
      consultantById.set(p.id as string, {
        id: p.id as string,
        name: (p.full_name as string) || "(unnamed)",
        active: (p.active as boolean) ?? true,
        ltftDaysOff: new Set(raw.map((n) => Number(n))),
      });
    }
  }
  const totalActiveConsultants = [...consultantById.values()].filter((c) => c.active).length;

  const theatreName = new Map<string, string>();
  for (const t of theatres ?? []) theatreName.set(t.id as string, (t.name as string) || "Theatre");

  // Index assignments by theatre_session_id (who actually covered each list)
  // and by (date, staffId) for whole-person status on a given date.
  type Asn = {
    staffId: string;
    date: string;
    session: string;
    dutyType: string;
    roleOnList: string;
    theatreSessionId: string | null;
  };
  const asnByTheatreSession = new Map<string, Asn[]>();
  const asnByDateStaff = new Map<string, Asn[]>(); // key: date|staffId
  // (date|session) -> set of consultant staffIds with duty_type='theatre' that
  // half (linked OR unlinked). Used to detect "owner busy on another list".
  const consultantsOnTheatreByDateSession = new Map<string, Set<string>>();
  // Per-date set of every staffId with ANY duty record. Used by isCoveredDayThin.
  const staffWithAnyRecordByDate = new Map<string, Set<string>>();
  // Data-quality counters.
  let theatreAssignmentsTotal = 0;
  let theatreAssignmentsLinked = 0;

  for (const a of assignments ?? []) {
    const row: Asn = {
      staffId: a.staff_id as string,
      date: a.session_date as string,
      session: a.session as string,
      dutyType: a.duty_type as string,
      roleOnList: a.role_on_list as string,
      theatreSessionId: (a.theatre_session_id as string | null) ?? null,
    };
    if (row.theatreSessionId) {
      const arr = asnByTheatreSession.get(row.theatreSessionId) ?? [];
      arr.push(row);
      asnByTheatreSession.set(row.theatreSessionId, arr);
    }
    const k = `${row.date}|${row.staffId}`;
    const arr2 = asnByDateStaff.get(k) ?? [];
    arr2.push(row);
    asnByDateStaff.set(k, arr2);

    // Day-level "anyone here" set (for thin-day proxy).
    let dayStaff = staffWithAnyRecordByDate.get(row.date);
    if (!dayStaff) {
      dayStaff = new Set();
      staffWithAnyRecordByDate.set(row.date, dayStaff);
    }
    dayStaff.add(row.staffId);

    // (date|session) → consultants doing theatre that half — linked or not.
    if (
      row.dutyType === "theatre" &&
      (row.session === "am" || row.session === "pm") &&
      consultantById.has(row.staffId)
    ) {
      const key = `${row.date}|${row.session}`;
      let set = consultantsOnTheatreByDateSession.get(key);
      if (!set) {
        set = new Set();
        consultantsOnTheatreByDateSession.set(key, set);
      }
      set.add(row.staffId);
      theatreAssignmentsTotal += 1;
      if (row.theatreSessionId) theatreAssignmentsLinked += 1;
    }
  }

  // ----- Consultant working patterns --------------------------------------
  // For each consultant we compute:
  //   - tenureStart / tenureEnd: first and last dates within the data window
  //     where the consultant appears in the rota at all. Consultants who
  //     started recently (or have left) should not be penalised by weekdays
  //     before/after their tenure.
  //   - totalOccurrences per (dow, session): count of weekdays of that dow
  //     that have a theatre_session AND fall inside their tenure.
  //   - workingOccurrences: theatre-list assignments on that half-day.
  //   - oncallOccurrences: on-call assignments on that half-day (info only;
  //     on-call weeks are NOT removed from the denominator).
  const dowDates = new Map<number, string[]>(); // dow -> ISO dates with a theatre_session
  const seenDates = new Set<string>();
  for (const s of sessions ?? []) {
    const date = s.session_date as string;
    if (seenDates.has(date)) continue;
    seenDates.add(date);
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const arr = dowDates.get(dow) ?? [];
    arr.push(date);
    dowDates.set(dow, arr);
  }
  for (const arr of dowDates.values()) arr.sort();

  // First/last date this consultant appears in the rota (any duty_type)
  // within the window.
  const tenureBounds = new Map<string, { first: string; last: string }>();
  for (const [k] of asnByDateStaff) {
    const sep = k.indexOf("|");
    const date = k.slice(0, sep);
    const staffId = k.slice(sep + 1);
    if (!consultantById.has(staffId)) continue;
    const cur = tenureBounds.get(staffId);
    if (!cur) {
      tenureBounds.set(staffId, { first: date, last: date });
    } else {
      if (date < cur.first) cur.first = date;
      if (date > cur.last) cur.last = date;
    }
  }

  // Per-consultant, per (dow|session), clinical-activity and on-call counts.
  type PatternCounts = { clinical: number; oncall: number };
  const patternCounts = new Map<string, PatternCounts>(); // key: staffId|dow|session
  const cellKey = (staffId: string, dow: number, session: string) =>
    `${staffId}|${dow}|${session}`;

  for (const [k, rows] of asnByDateStaff) {
    const sep = k.indexOf("|");
    const date = k.slice(0, sep);
    const staffId = k.slice(sep + 1);
    if (!consultantById.has(staffId)) continue;
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const seenHalf = new Map<string, { clinical: boolean; oncall: boolean }>();
    for (const a of rows) {
      if (a.session !== "am" && a.session !== "pm") continue;
      const isOncall = a.dutyType.endsWith("_oncall");
      const isClinical = a.dutyType === "theatre";
      const flag = seenHalf.get(a.session) ?? { clinical: false, oncall: false };
      if (isOncall) flag.oncall = true;
      if (isClinical) flag.clinical = true;
      seenHalf.set(a.session, flag);
    }
    for (const [sess, flag] of seenHalf) {
      const key = cellKey(staffId, dow, sess);
      const cur = patternCounts.get(key) ?? { clinical: 0, oncall: 0 };
      if (flag.clinical) cur.clinical += 1;
      if (flag.oncall) cur.oncall += 1;
      patternCounts.set(key, cur);
    }
  }

  // Count weekdays of `dow` that have a theatre_session between first..last (inclusive).
  const countDowInRange = (dow: number, first: string, last: string): number => {
    const arr = dowDates.get(dow);
    if (!arr || arr.length === 0) return 0;
    let n = 0;
    for (const d of arr) {
      if (d < first) continue;
      if (d > last) break;
      n += 1;
    }
    return n;
  };

  const countWeekdays = (first: string, last: string): number => {
    if (first > last) return 0;
    let n = 0;
    const start = new Date(first + "T00:00:00Z");
    const end = new Date(last + "T00:00:00Z");
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) n += 1;
    }
    return n;
  };

  const consultantPatterns: ConsultantPattern[] = [];
  const SESSIONS: Array<"am" | "pm"> = ["am", "pm"];
  for (const c of consultantById.values()) {
    if (!c.active) continue;
    const bounds = tenureBounds.get(c.id);
    const tenureStart = bounds ? (bounds.first < windowStart ? windowStart : bounds.first) : null;
    const tenureEnd = bounds ? (bounds.last > windowEnd ? windowEnd : bounds.last) : null;
    const cells: ConsultantPatternCell[] = [];
    let regularSessions = 0;
    for (let dow = 1; dow <= 5; dow++) {
      const total = tenureStart && tenureEnd
        ? countDowInRange(dow, tenureStart, tenureEnd)
        : 0;
      for (const session of SESSIONS) {
        const counts = patternCounts.get(cellKey(c.id, dow, session)) ?? {
          clinical: 0,
          oncall: 0,
        };
        const workingPct =
          total > 0 ? Math.round((counts.clinical / total) * 100) : 0;
        const regular = workingPct >= thresholds.regularWorkingMinPct;
        if (regular) regularSessions += 1;
        cells.push({
          dow,
          session,
          totalOccurrences: total,
          oncallOccurrences: counts.oncall,
          workingOccurrences: counts.clinical,
          workingPct,
          regular,
        });
      }
    }
    consultantPatterns.push({
      id: c.id,
      name: c.name,
      cells,
      regularSessionsPerWeek: regularSessions,
      tenureStart,
      tenureEnd,
      tenureWeekdays: tenureStart && tenureEnd ? countWeekdays(tenureStart, tenureEnd) : 0,
    });
  }
  consultantPatterns.sort((a, b) => a.name.localeCompare(b.name));

  // Quick lookup: which consultants regularly work each (dow, session)?
  const regularByCell = new Map<string, ConsultantPattern[]>();
  for (const pat of consultantPatterns) {
    for (const cell of pat.cells) {
      if (!cell.regular) continue;
      const k = `${cell.dow}|${cell.session}`;
      const arr = regularByCell.get(k) ?? [];
      arr.push(pat);
      regularByCell.set(k, arr);
    }
  }
  const patternById = new Map(consultantPatterns.map((p) => [p.id, p]));
  const workingPctOf = (staffId: string, dow: number, session: string): number => {
    const pat = patternById.get(staffId);
    if (!pat) return 0;
    const cell = pat.cells.find((c) => c.dow === dow && c.session === session);
    return cell?.workingPct ?? 0;
  };


  // Group theatre_sessions into recurring slots.
  type Slot = {
    key: string;
    dow: number;
    session: "am" | "pm";
    theatreId: string;
    surgeonRaw: string;
    surgeonNorm: string;
    occurrences: {
      theatreSessionId: string;
      date: string;
    }[];
  };
  const slotMap = new Map<string, Slot>();
  for (const s of sessions ?? []) {
    const sess = s.session as string;
    if (sess !== "am" && sess !== "pm") continue;
    const date = s.session_date as string;
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const theatreId = (s.theatre_id as string) ?? "";
    if (!theatreId) continue;
    const surgeonRaw = (s.surgical_consultant as string | null) ?? "";
    if (isEmergencySession((s.specialty_id as string | null) ?? null, surgeonRaw)) {
      continue;
    }
    const surgeonNorm = normaliseSurgeon(surgeonRaw);
    const key = `${dow}|${sess}|${theatreId}|${surgeonNorm}`;
    const existing = slotMap.get(key);
    const occ = { theatreSessionId: s.id as string, date };
    if (existing) {
      existing.occurrences.push(occ);
    } else {
      slotMap.set(key, {
        key,
        dow,
        session: sess,
        theatreId,
        surgeonRaw,
        surgeonNorm,
        occurrences: [occ],
      });
    }
  }

  // Build per-slot feasibility.
  const slotResults: ListSlotFeasibility[] = [];

  for (const slot of slotMap.values()) {
    if (slot.occurrences.length < thresholds.minOccurrences) continue;

    // Count consultant frequency on this slot.
    const freq = new Map<string, number>();
    for (const occ of slot.occurrences) {
      const asns = asnByTheatreSession.get(occ.theatreSessionId) ?? [];
      for (const a of asns) {
        if (a.dutyType !== "theatre") continue;
        const c = consultantById.get(a.staffId);
        if (!c) continue;
        freq.set(a.staffId, (freq.get(a.staffId) ?? 0) + 1);
      }
    }
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [ownerId, ownerCovered] = ranked[0] ?? [null, 0];
    const [deputyId, deputyCovered] = ranked[1] ?? [null, 0];

    // Per-occurrence: was owner free, busy elsewhere, or unavailable?
    let ownerOrDeputyCovered = 0;
    let ownerUnavailable = 0;
    let ownerFreeButReplaced = 0;
    let shortfallsIfLocked = 0;

    for (const occ of slot.occurrences) {
      const asns = asnByTheatreSession.get(occ.theatreSessionId) ?? [];
      // A session can have multiple consultants assigned — iterate all.
      const coverers = new Set(
        asns.filter((a) => a.dutyType === "theatre").map((a) => a.staffId),
      );
      const coveredByOwnerOrDeputy =
        (ownerId && coverers.has(ownerId)) || (deputyId && coverers.has(deputyId));
      if (coveredByOwnerOrDeputy) ownerOrDeputyCovered += 1;

      if (!ownerId) continue;
      const ownerAsnsToday = asnByDateStaff.get(`${occ.date}|${ownerId}`) ?? [];
      const ownerOnThisSession = ownerAsnsToday.find(
        (a) => a.session === slot.session && a.theatreSessionId === occ.theatreSessionId,
      );
      if (ownerOnThisSession) continue; // owner did cover

      // Owner did not cover (or attribution isn't linked). Why?
      const ownerSameHalf = ownerAsnsToday.find((a) => a.session === slot.session);
      const ownerAllDay = ownerAsnsToday;
      // Key fix: if the owner has duty_type='theatre' on the SAME half but
      // it's either linked to a different theatre_session OR unlinked
      // entirely, they were busy on some other list and physically cannot
      // also cover this one. Count as unavailable, not "free but replaced".
      const ownerBusyOnOtherTheatre =
        ownerSameHalf?.dutyType === "theatre";
      const dt = ownerSameHalf?.dutyType ?? ownerAllDay[0]?.dutyType;
      const isUnavailable = !!dt && dt !== "theatre"; // leave/on-call/SPA/admin/obstetrics/etc.

      if (ownerBusyOnOtherTheatre || isUnavailable) {
        ownerUnavailable += 1;
      } else if (ownerAllDay.length === 0) {
        // No record at all that day. Could be approved leave (not synced as
        // an assignment row) or a true gap. Conservative: free-but-replaced.
        ownerFreeButReplaced += 1;
        shortfallsIfLocked += isCoveredDayThin(
          staffWithAnyRecordByDate,
          occ.date,
          totalActiveConsultants,
          thresholds.shortfallDayBusyPct,
        )
          ? 1
          : 0;
      } else {
        // Owner had some record that day but not on this half and not theatre.
        ownerFreeButReplaced += 1;
      }

    }

    const ownerPresentPct = Math.round((ownerCovered / slot.occurrences.length) * 100);
    const ownerOrDeputyPct = Math.round(
      (ownerOrDeputyCovered / slot.occurrences.length) * 100,
    );

    const reasons: string[] = [];
    const ownerBand = classify(ownerPresentPct, thresholds.ownerPresentMinPct);
    const deputyBand = classify(ownerOrDeputyPct, thresholds.ownerOrDeputyMinPct);
    const shortfallFail =
      thresholds.forbidNewShortfalls && shortfallsIfLocked > 0;

    let verdict: Verdict;
    if (!ownerId) {
      verdict = "not_feasible";
      reasons.push("No consultant has ever covered this list.");
    } else if (ownerBand === "above" && deputyBand === "above" && !shortfallFail) {
      verdict = "feasible";
    } else if (ownerBand !== "below" && deputyBand !== "below" && !shortfallFail) {
      verdict = "borderline";
      if (ownerBand === "near") reasons.push(`Owner present only ${ownerPresentPct}%.`);
      if (deputyBand === "near") reasons.push(`Owner+deputy only ${ownerOrDeputyPct}%.`);
    } else {
      verdict = "not_feasible";
      if (ownerBand === "below")
        reasons.push(`Owner present ${ownerPresentPct}% — below ${thresholds.ownerPresentMinPct}%.`);
      if (deputyBand === "below")
        reasons.push(
          `Owner+deputy ${ownerOrDeputyPct}% — below ${thresholds.ownerOrDeputyMinPct}%.`,
        );
      if (shortfallFail)
        reasons.push(`${shortfallsIfLocked} session(s) would tip the day into shortfall.`);
    }

    // Headcount gap heuristic:
    //  - 1 extra if owner band is "below"
    //  - +1 extra if deputy band is also "below"
    //  - 0 otherwise
    let headcountGap = 0;
    if (ownerBand === "below") headcountGap += 1;
    if (deputyBand === "below") headcountGap += 1;

    // Candidate owners — consultants whose regular weekly pattern includes
    // this (dow, session). Always include the current proposed owner/deputy
    // even if their working % falls below the regular-pattern threshold, so
    // the user sees why they were nominated.
    const candidateOwners: CandidateOwner[] = [];
    const seenCandidates = new Set<string>();
    const pushCandidate = (id: string, name: string) => {
      if (seenCandidates.has(id)) return;
      seenCandidates.add(id);
      candidateOwners.push({
        id,
        name,
        workingPct: workingPctOf(id, slot.dow, slot.session),
        isCurrentOwner: id === ownerId,
        isCurrentDeputy: id === deputyId,
      });
    };
    for (const pat of regularByCell.get(`${slot.dow}|${slot.session}`) ?? []) {
      pushCandidate(pat.id, pat.name);
    }
    if (ownerId) {
      const c = consultantById.get(ownerId);
      if (c) pushCandidate(ownerId, c.name);
    }
    if (deputyId) {
      const c = consultantById.get(deputyId);
      if (c) pushCandidate(deputyId, c.name);
    }
    candidateOwners.sort((a, b) => b.workingPct - a.workingPct);

    slotResults.push({
      key: slot.key,
      dow: slot.dow,
      session: slot.session,
      theatreId: slot.theatreId,
      theatreName: theatreName.get(slot.theatreId) ?? "Theatre",
      surgeon: displaySurgeon(slot.surgeonRaw),
      occurrences: slot.occurrences.length,
      ownerId,
      ownerName: ownerId ? consultantById.get(ownerId)?.name ?? null : null,
      ownerCovered,
      ownerPresentPct,
      deputyId,
      deputyName: deputyId ? consultantById.get(deputyId)?.name ?? null : null,
      deputyCovered,
      ownerOrDeputyPct,
      ownerUnavailable,
      ownerFreeButReplaced,
      shortfallsIfLocked,
      verdict,
      headcountGap,
      reasons,
      candidateOwners,
    });
  }


  // Dept rollup. A slot that runs once/week ≈ 0.1 WTE per session (10 PAs/week).
  // We treat the gap as: per missing consultant, 1/10 WTE per regular session/week.
  const totalSlots = slotResults.length;
  const feasible = slotResults.filter((s) => s.verdict === "feasible").length;
  const borderline = slotResults.filter((s) => s.verdict === "borderline").length;
  const notFeasible = slotResults.filter((s) => s.verdict === "not_feasible").length;
  const estimatedExtraWte =
    Math.round(
      slotResults.reduce((acc, s) => acc + s.headcountGap * thresholds.wtePerWeeklySession, 0) *
        10,
    ) / 10;

  // Sort: not_feasible first, then borderline, then by occurrences desc.
  slotResults.sort((a, b) => {
    const order = { not_feasible: 0, borderline: 1, feasible: 2 } as const;
    const d = order[a.verdict] - order[b.verdict];
    if (d !== 0) return d;
    return b.occurrences - a.occurrences;
  });

  return {
    summary: {
      windowStart,
      windowEnd,
      thresholds,
      totalSlots,
      feasible,
      borderline,
      notFeasible,
      estimatedExtraWte,
      theatreAssignmentsTotal,
      theatreAssignmentsLinked,
    },
    slots: slotResults,
    consultantPatterns,
  };
}


/**
 * Crude proxy for "the day was thin on consultants": if more than ~70%
 * of all active consultants had any duty_type record that day, there was
 * very little spare cover. Used only as a heuristic for the
 * "shortfalls if locked" counter without re-running the full robustness
 * simulation. Takes a precomputed date -> staffId set to avoid scanning
 * the full assignment map per occurrence.
 */
function isCoveredDayThin(
  staffWithAnyRecordByDate: Map<string, Set<string>>,
  date: string,
  totalActiveConsultants: number,
  busyPct: number,
): boolean {
  if (totalActiveConsultants === 0) return false;
  const set = staffWithAnyRecordByDate.get(date);
  if (!set) return false;
  return set.size / totalActiveConsultants > busyPct / 100;
}

export const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
