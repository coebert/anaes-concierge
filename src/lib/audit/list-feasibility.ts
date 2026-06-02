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
}

export const DEFAULT_THRESHOLDS: FeasibilityThresholds = {
  ownerPresentMinPct: 80,
  ownerOrDeputyMinPct: 95,
  forbidNewShortfalls: true,
  minOccurrences: 4,
  shortfallDayBusyPct: 70,
  wtePerWeeklySession: 0.1,
};

export type Verdict = "feasible" | "borderline" | "not_feasible";

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
}

export interface ListFeasibilityResult {
  summary: DepartmentSummary;
  slots: ListSlotFeasibility[];
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

  const [{ data: profiles }, { data: theatres }, { data: sessions }, { data: assignments }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, grade, active"),
      supabase
        .from("theatres")
        .select("id, name"),
      supabase
        .from("theatre_sessions")
        .select("id, session_date, session, theatre_id, surgical_consultant")
        .gte("session_date", windowStart)
        .lte("session_date", windowEnd),
      supabase
        .from("rota_assignments")
        .select("staff_id, session_date, session, duty_type, role_on_list, theatre_session_id")
        .gte("session_date", windowStart)
        .lte("session_date", windowEnd),
    ]);

  const consultantById = new Map<string, { id: string; name: string; active: boolean }>();
  for (const p of profiles ?? []) {
    if ((p.grade as Grade) === "consultant") {
      consultantById.set(p.id as string, {
        id: p.id as string,
        name: (p.full_name as string) || "(unnamed)",
        active: (p.active as boolean) ?? true,
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
  }

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
      const coverer = asns.find((a) => a.dutyType === "theatre")?.staffId;
      const coveredByOwnerOrDeputy =
        (ownerId && coverer === ownerId) || (deputyId && coverer === deputyId);
      if (coveredByOwnerOrDeputy) ownerOrDeputyCovered += 1;

      if (!ownerId) continue;
      const ownerAsnsToday = asnByDateStaff.get(`${occ.date}|${ownerId}`) ?? [];
      const ownerOnThisSession = ownerAsnsToday.find(
        (a) => a.session === slot.session && a.theatreSessionId === occ.theatreSessionId,
      );
      if (ownerOnThisSession) continue; // owner did cover

      // Owner did not cover. Why?
      const ownerSameHalf = ownerAsnsToday.find((a) => a.session === slot.session);
      const ownerAllDay = ownerAsnsToday;
      const dt = ownerSameHalf?.dutyType ?? ownerAllDay[0]?.dutyType;
      const isUnavailable = !!dt && dt !== "theatre"; // leave/on-call/SPA/admin/etc all surface as a non-theatre duty_type record
      // Approved leave isn't necessarily recorded as a rota_assignment row;
      // a totally empty day for a working consultant is treated as "free
      // but replaced" only if it's not a known leave day. We don't have
      // leave data wired here yet — treat "no record on that half" as
      // "free but replaced" which is a conservative read.
      if (ownerAllDay.length === 0) {
        ownerFreeButReplaced += 1;
        // If owner were locked here, the *other* list they were covering
        // wouldn't exist to lose — but the redirected consultant who
        // covered here would no longer be free. Treat as potential
        // shortfall when no spare consultants were free on that day.
        // Heuristic only — proper sim would re-run robustness.
        shortfallsIfLocked += isCoveredDayThin(
          asnByDateStaff,
          occ.date,
          totalActiveConsultants,
          thresholds.shortfallDayBusyPct,
        )
          ? 1
          : 0;
      } else if (isUnavailable) {
        ownerUnavailable += 1;
      } else {
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
      slotResults.reduce((acc, s) => acc + s.headcountGap * 0.1, 0) * 10,
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
    },
    slots: slotResults,
  };
}

/**
 * Crude proxy for "the day was thin on consultants": if more than ~70%
 * of all active consultants had any duty_type record that day, there was
 * very little spare cover. Used only as a heuristic for the
 * "shortfalls if locked" counter without re-running the full robustness
 * simulation.
 */
function isCoveredDayThin(
  asnByDateStaff: Map<string, { staffId: string }[]>,
  date: string,
  totalActiveConsultants: number,
): boolean {
  if (totalActiveConsultants === 0) return false;
  const staffWithAnyRecord = new Set<string>();
  for (const [key, rows] of asnByDateStaff) {
    if (!key.startsWith(date + "|")) continue;
    for (const r of rows) staffWithAnyRecord.add(r.staffId);
  }
  return staffWithAnyRecord.size / totalActiveConsultants > 0.7;
}

export const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
