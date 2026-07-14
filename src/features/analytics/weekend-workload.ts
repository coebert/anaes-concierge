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
