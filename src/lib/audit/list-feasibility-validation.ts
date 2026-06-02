/**
 * One-click validation report for the list-feasibility consultant
 * working-pattern matrix.
 *
 * For every consultant × (dow, session) cell the model produces, this
 * routine pulls the underlying rota_assignments rows out of the same
 * window and recomputes a "sampled" working percentage independently,
 * using a deliberately simple rule set:
 *
 *   - classification per (date, session) for that consultant:
 *       clinical      → duty_type = "theatre" AND notes is not a
 *                       non-working label
 *       off_day_label → any record whose notes match an "Off Day" /
 *                       "Day Off" / "Not working" pattern (these rows
 *                       are excluded from the denominator)
 *       other_duty    → any other duty_type (on-call, SPA, admin,
 *                       leave, obstetrics, …)
 *       no_record     → consultant has no rota row for that half-day
 *
 *   - sampledPct = clinical / max(1, sampleSize − off_day_label) × 100
 *
 * The cell is flagged when |modelPct − sampledPct| exceeds the
 * configurable mismatch threshold (default 15 percentage points).
 *
 * The report also surfaces the actual sampled rows so a human can spot
 * mis-imported CLWRota labels, mis-classified duties, or other data
 * quality problems behind any apparent discrepancy.
 */

import { supabase } from "@/integrations/supabase/client";
import { isNonWorkingRotaLabel } from "@/lib/clwrota-labels";
import {
  computeListFeasibility,
  type ConsultantPattern,
  type FeasibilityThresholds,
} from "./list-feasibility";
import type { Grade } from "./robustness";

export type SampleClassification =
  | "clinical"
  | "off_day_label"
  | "other_duty"
  | "no_record";

export interface ValidationSample {
  date: string;
  classification: SampleClassification;
  dutyType: string | null;
  roleOnList: string | null;
  notes: string | null;
}

export interface ValidationCell {
  dow: number;
  session: "am" | "pm";
  /** Pattern value the model produced (workingPct). */
  modelPct: number;
  modelRegular: boolean;
  modelRegularDayOff: boolean;
  /** Total dates of this dow inside the consultant's tenure. */
  tenureDates: number;
  /** Number of dates sampled (capped at sampleCap). */
  sampleSize: number;
  clinical: number;
  offDayLabel: number;
  otherDuty: number;
  noRecord: number;
  /** Independent recompute: clinical / max(1, sampleSize − offDayLabel) × 100. */
  sampledPct: number;
  /** sampledPct − modelPct (positive = sampled higher than model). */
  delta: number;
  mismatch: boolean;
  samples: ValidationSample[];
}

export interface ValidationConsultant {
  id: string;
  name: string;
  tenureStart: string | null;
  tenureEnd: string | null;
  cells: ValidationCell[];
  /** Largest |delta| across the consultant's 10 cells. */
  maxAbsDelta: number;
  mismatchCount: number;
}

export interface ValidationReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  monthsBack: number;
  sampleCap: number;
  mismatchThresholdPct: number;
  consultants: ValidationConsultant[];
  totalCells: number;
  cellsWithMismatch: number;
  consultantsWithMismatch: number;
}

export interface ValidationOptions {
  monthsBack?: number;
  thresholds?: Partial<FeasibilityThresholds>;
  /** Max number of dates sampled per consultant cell. Default 10. */
  sampleCap?: number;
  /** % point gap above which a cell is reported as mismatched. Default 15. */
  mismatchThresholdPct?: number;
  /** Override clock for tests. */
  todayOverride?: string;
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Deterministic pseudo-random sample so repeated runs are comparable. */
function deterministicSample<T>(arr: T[], cap: number, seed: string): T[] {
  if (arr.length <= cap) return [...arr];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const indexed = arr.map((v, i) => {
    h = (h * 1103515245 + 12345) | 0;
    return { v, k: (h ^ i) >>> 0 };
  });
  indexed.sort((a, b) => a.k - b.k);
  return indexed.slice(0, cap).map((x) => x.v);
}

export async function validateConsultantPatterns(
  opts: ValidationOptions = {},
): Promise<ValidationReport> {
  const monthsBack = opts.monthsBack ?? 6;
  const sampleCap = opts.sampleCap ?? 10;
  const mismatchThresholdPct = opts.mismatchThresholdPct ?? 15;

  const windowEnd = opts.todayOverride ?? todayISO();
  const windowStart = (() => {
    const d = new Date(windowEnd + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() - monthsBack);
    return d.toISOString().slice(0, 10);
  })();

  // Fetch custom non-working labels first so the model can honour them too
  // (otherwise the model would re-flag the same cells the sampler considers
  // off-day, and "Apply all fixes & re-run" would never change the report).
  const customLabels = await fetchAllRows((from, to) =>
    supabase
      .from("validation_custom_non_working_labels")
      .select("token")
      .order("token", { ascending: true })
      .range(from, to),
  );

  const extraNonWorkingTokens = (customLabels ?? [])
    .map((r) => (r as { token: string }).token)
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  // Run the model (with the same extra tokens) and pull raw rota rows +
  // profiles in parallel.
  const [modelResult, profiles, assignments] = await Promise.all([
    computeListFeasibility({
      monthsBack,
      thresholds: opts.thresholds,
      todayOverride: opts.todayOverride,
      extraNonWorkingTokens,
    }),
    fetchAllRows((from, to) =>
      supabase
        .from("profiles")
        .select("id, grade, active")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("rota_assignments")
        .select("staff_id, session_date, session, duty_type, role_on_list, notes")
        .gte("session_date", windowStart)
        .lte("session_date", windowEnd)
        .order("session_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const consultantIds = new Set<string>();
  for (const p of profiles ?? []) {
    if ((p.grade as Grade) === "consultant" && ((p.active as boolean) ?? true)) {
      consultantIds.add(p.id as string);
    }
  }

  // Index assignments: (staffId|date|session) → rows[]
  type Asn = {
    dutyType: string;
    roleOnList: string | null;
    notes: string | null;
  };
  const asnIndex = new Map<string, Asn[]>();
  for (const a of assignments ?? []) {
    const staffId = a.staff_id as string;
    if (!consultantIds.has(staffId)) continue;
    const session = a.session as string;
    if (session !== "am" && session !== "pm") continue;
    const key = `${staffId}|${a.session_date as string}|${session}`;
    const arr = asnIndex.get(key) ?? [];
    arr.push({
      dutyType: a.duty_type as string,
      roleOnList: (a.role_on_list as string | null) ?? null,
      notes: (a.notes as string | null) ?? null,
    });
    asnIndex.set(key, arr);
  }

  function classify(rows: Asn[]): {
    classification: SampleClassification;
    dutyType: string | null;
    roleOnList: string | null;
    notes: string | null;
  } {
    if (rows.length === 0) {
      return { classification: "no_record", dutyType: null, roleOnList: null, notes: null };
    }
    // Off-day label wins regardless of duty_type — these rows should never
    // count as clinical activity.
    const offDayRow = rows.find((r) => isNonWorkingRotaLabel([r.notes], extraNonWorkingTokens));
    if (offDayRow) {
      return {
        classification: "off_day_label",
        dutyType: offDayRow.dutyType,
        roleOnList: offDayRow.roleOnList,
        notes: offDayRow.notes,
      };
    }
    const clinical = rows.find((r) => r.dutyType === "theatre");
    if (clinical) {
      return {
        classification: "clinical",
        dutyType: clinical.dutyType,
        roleOnList: clinical.roleOnList,
        notes: clinical.notes,
      };
    }
    const other = rows[0];
    return {
      classification: "other_duty",
      dutyType: other.dutyType,
      roleOnList: other.roleOnList,
      notes: other.notes,
    };
  }

  function enumerateDates(first: string, last: string, dow: number): string[] {
    const out: string[] = [];
    const start = new Date(first + "T00:00:00Z");
    const end = new Date(last + "T00:00:00Z");
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === dow) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  const validated: ValidationConsultant[] = [];
  let cellsWithMismatch = 0;
  let consultantsWithMismatch = 0;

  for (const pat of modelResult.consultantPatterns as ConsultantPattern[]) {
    const cells: ValidationCell[] = [];
    let maxAbsDelta = 0;
    let mismatchCount = 0;

    for (const modelCell of pat.cells) {
      const tenureDates =
        pat.tenureStart && pat.tenureEnd
          ? enumerateDates(pat.tenureStart, pat.tenureEnd, modelCell.dow)
          : [];

      const sampled = deterministicSample(
        tenureDates,
        sampleCap,
        `${pat.id}|${modelCell.dow}|${modelCell.session}`,
      ).sort();

      let clinical = 0;
      let offDayLabel = 0;
      let otherDuty = 0;
      let noRecord = 0;
      const samples: ValidationSample[] = [];

      for (const date of sampled) {
        const rows =
          asnIndex.get(`${pat.id}|${date}|${modelCell.session}`) ?? [];
        const c = classify(rows);
        if (c.classification === "clinical") clinical += 1;
        else if (c.classification === "off_day_label") offDayLabel += 1;
        else if (c.classification === "other_duty") otherDuty += 1;
        else noRecord += 1;
        samples.push({
          date,
          classification: c.classification,
          dutyType: c.dutyType,
          roleOnList: c.roleOnList,
          notes: c.notes,
        });
      }

      const denom = Math.max(1, sampled.length - offDayLabel);
      const sampledPct =
        sampled.length === 0 ? 0 : Math.round((clinical / denom) * 100);
      // If the model marks this as a regular day off, compare against 0%
      // rather than the (always-zero) modelPct — the validator should
      // independently verify the day-off classification.
      const effectiveModelPct = modelCell.regularDayOff ? 0 : modelCell.workingPct;
      const delta = sampled.length === 0 ? 0 : sampledPct - effectiveModelPct;
      const absDelta = Math.abs(delta);
      // Skip mismatch flagging when sample is too small to be informative.
      const mismatch = sampled.length >= 3 && absDelta > mismatchThresholdPct;
      if (absDelta > maxAbsDelta) maxAbsDelta = absDelta;
      if (mismatch) {
        mismatchCount += 1;
        cellsWithMismatch += 1;
      }
      cells.push({
        dow: modelCell.dow,
        session: modelCell.session,
        modelPct: modelCell.workingPct,
        modelRegular: modelCell.regular,
        modelRegularDayOff: modelCell.regularDayOff,
        tenureDates: tenureDates.length,
        sampleSize: sampled.length,
        clinical,
        offDayLabel,
        otherDuty,
        noRecord,
        sampledPct,
        delta,
        mismatch,
        samples,
      });
    }

    if (mismatchCount > 0) consultantsWithMismatch += 1;
    validated.push({
      id: pat.id,
      name: pat.name,
      tenureStart: pat.tenureStart,
      tenureEnd: pat.tenureEnd,
      cells,
      maxAbsDelta,
      mismatchCount,
    });
  }

  // Sort: consultants with mismatches first, then by largest delta.
  validated.sort((a, b) => {
    if (a.mismatchCount !== b.mismatchCount) return b.mismatchCount - a.mismatchCount;
    if (a.maxAbsDelta !== b.maxAbsDelta) return b.maxAbsDelta - a.maxAbsDelta;
    return a.name.localeCompare(b.name);
  });

  return {
    generatedAt: new Date().toISOString(),
    windowStart,
    windowEnd,
    monthsBack,
    sampleCap,
    mismatchThresholdPct,
    consultants: validated,
    totalCells: validated.reduce((acc, c) => acc + c.cells.length, 0),
    cellsWithMismatch,
    consultantsWithMismatch,
  };
}
