// Pure helpers for the "Weekend workload (job plan)" analytics page.
//
// Extracted from the route component so we can unit-test the counting
// rules independently of Supabase / React:
//   - Only Saturday/Sunday sessions count.
//   - `extra_type` (extras / locum / WLI) rows are excluded.
//   - SAG (private) lists are excluded — i.e. theatre.kind === "private"
//     AND the row is NOT flagged non_sag. Non-SAG NHH cover stays in.
//   - Multiple sessions on the same date collapse to a single weekend day
//     (distinct Sat/Sun dates per staff member).

export type WeekendWorkloadRow = {
  staff_id: string | null;
  session_date: string | null;
  is_non_sag: boolean | null;
  extra_type: string | null;
  theatre_sessions:
    | { is_non_sag: boolean | null; theatres: { kind: string | null } | null }
    | null;
};

export function isWeekendISO(isoDate: string): boolean {
  // UTC noon avoids DST / TZ edge cases at date boundaries.
  const dow = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** True when the row is a SAG (private) list that must be excluded. */
export function isExcludedSagRow(row: WeekendWorkloadRow): boolean {
  const kind = row.theatre_sessions?.theatres?.kind ?? null;
  const rowNonSag =
    row.is_non_sag || row.theatre_sessions?.is_non_sag || false;
  return kind === "private" && !rowNonSag;
}

export type WeekendCount = {
  staff_id: string;
  total: number;
  sat: number;
  sun: number;
};

/**
 * Count distinct Sat/Sun dates per staff member from a set of rota rows,
 * applying the job-plan exclusions (extras/locum/WLI + SAG private).
 */
export function countWeekendDates(
  rows: readonly WeekendWorkloadRow[],
): WeekendCount[] {
  const datesByStaff = new Map<string, Set<string>>();

  for (const r of rows) {
    if (!r.staff_id || !r.session_date) continue;
    if (r.extra_type) continue; // extras / locum / WLI
    if (!isWeekendISO(r.session_date)) continue;
    if (isExcludedSagRow(r)) continue;

    let set = datesByStaff.get(r.staff_id);
    if (!set) {
      set = new Set<string>();
      datesByStaff.set(r.staff_id, set);
    }
    set.add(r.session_date);
  }

  const out: WeekendCount[] = [];
  for (const [staff_id, dates] of datesByStaff) {
    let sat = 0;
    let sun = 0;
    for (const iso of dates) {
      const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
      if (dow === 6) sat++;
      else if (dow === 0) sun++;
    }
    out.push({ staff_id, total: dates.size, sat, sun });
  }
  return out.sort((a, b) => b.total - a.total || a.staff_id.localeCompare(b.staff_id));
}

/** Categories of weekend sessions excluded from the job-plan count. */
export type ExtraCategory = "extra" | "locum" | "wli" | "sag";

/**
 * Classify a weekend row into one of the "not job-planned" buckets, or
 * `null` when it's a normal job-plan session (counted by countWeekendDates).
 *
 * - extra_type of "extra" / "locum" / "wli" / "sag" maps directly.
 * - Any other non-null extra_type is treated as an "extra" for counting.
 * - A row with no extra_type but on a SAG private list
 *   (theatre.kind === "private" AND not flagged non_sag) is bucketed as "sag".
 */
export function classifyExtraCategory(
  row: WeekendWorkloadRow,
): ExtraCategory | null {
  const raw = row.extra_type?.trim().toLowerCase() ?? "";
  if (raw) {
    if (raw === "locum") return "locum";
    if (raw === "wli") return "wli";
    if (raw === "sag") return "sag";
    // "extra" and any other non-empty tag fall into the extras bucket.
    return "extra";
  }
  if (isExcludedSagRow(row)) return "sag";
  return null;
}

export type ExtraCategoryCounts = Record<ExtraCategory, number>;

export type WeekendExtraCounts = {
  staff_id: string;
  extra: number;
  locum: number;
  wli: number;
  sag: number;
};

/**
 * Count distinct Sat/Sun dates per staff member for each "not job-planned"
 * category (extra / locum / WLI / SAG). A single weekend date only counts
 * once per category, even if the staff member had multiple sessions of
 * that kind on the same day. Different categories on the same date are
 * counted independently.
 */
export function countWeekendExtras(
  rows: readonly WeekendWorkloadRow[],
): WeekendExtraCounts[] {
  const perStaff = new Map<string, Record<ExtraCategory, Set<string>>>();

  for (const r of rows) {
    if (!r.staff_id || !r.session_date) continue;
    if (!isWeekendISO(r.session_date)) continue;
    const cat = classifyExtraCategory(r);
    if (!cat) continue;

    let bucket = perStaff.get(r.staff_id);
    if (!bucket) {
      bucket = { extra: new Set(), locum: new Set(), wli: new Set(), sag: new Set() };
      perStaff.set(r.staff_id, bucket);
    }
    bucket[cat].add(r.session_date);
  }

  const out: WeekendExtraCounts[] = [];
  for (const [staff_id, b] of perStaff) {
    out.push({
      staff_id,
      extra: b.extra.size,
      locum: b.locum.size,
      wli: b.wli.size,
      sag: b.sag.size,
    });
  }
  return out;
}

