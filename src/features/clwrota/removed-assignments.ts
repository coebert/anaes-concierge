/**
 * Removed-assignment reconciliation (import side).
 *
 * The assignments feed has no tombstones: when CLWRota drops an assignment
 * (for example when leave is approved over it, or a coordinator clears the
 * cell) the row simply stops appearing. Until now the import never removed
 * those rows, so stale theatre/on-call assignments stayed in the app and made
 * lists look staffed and people look busy.
 *
 * A stored CLWRota row is treated as removed in the source only when every
 * one of these holds:
 *  - it came from CLWRota (`source = 'clwrota'`) and was not edited locally;
 *  - its date is inside the run's requested window AND the feed returned at
 *    least one row for that date (a date with no rows at all is not evidence);
 *  - no row on that date was skipped for a reason that could hide a real row
 *    (unparseable session, no stable key, unmatched staff), and the run had
 *    no fetch/parse/write errors;
 *  - its key was not carried by ANY feed row in this run, working or not;
 *  - its date is today or later (`notBefore`): past rows are history the
 *    audits rely on, and the feed's past coverage has not been verified as
 *    complete, so they are counted (`absentPast`) but never removed here.
 * A size guard refuses the whole removal when the share of stored rows that
 * would go is implausibly large (a truncated or re-scoped feed), so a bad
 * fetch can never empty the rota.
 */
export interface StoredClwrotaRow {
  id: string;
  clwrota_external_id: string | null;
  session_date: string;
  source: string;
  locally_modified: boolean | null;
}

export interface RemovalInput {
  stored: readonly StoredClwrotaRow[];
  /** Every key the feed carried this run (working, non-working, split halves). */
  feedKeys: ReadonlySet<string>;
  /** Dates the feed returned at least one row for. */
  observedDates: ReadonlySet<string>;
  /** Dates with a row-level skip that could hide a real row. */
  uncertainDates: ReadonlySet<string>;
  window: { from: string; to: string } | null;
  /** First date eligible for removal (today); earlier rows are only counted. */
  notBefore: string;
  /** True when the run had a fetch/parse/write error or an undated row. */
  runUncertain: boolean;
  /** Refuse when more than this share of in-scope stored rows would go. */
  maxFraction?: number;
  /** ...but always allow at least this many. */
  minAllowed?: number;
}

export interface RemovalPlan {
  remove: string[];
  inScope: number;
  guard: "ok" | "run_uncertain" | "no_window" | "too_many";
  /** Rows kept only because their date was uncertain. */
  keptUncertainDate: number;
  keptLocallyModified: number;
  /** Absent from the feed but dated before `notBefore` — kept, reported. */
  absentPast: number;
}

export const REMOVAL_MAX_FRACTION = 0.1;
export const REMOVAL_MIN_ALLOWED = 25;

export function selectRemovedAssignments(input: RemovalInput): RemovalPlan {
  const empty = (guard: RemovalPlan["guard"]): RemovalPlan => ({
    remove: [],
    inScope: 0,
    guard,
    keptUncertainDate: 0,
    keptLocallyModified: 0,
    absentPast: 0,
  });
  if (!input.window) return empty("no_window");
  if (input.runUncertain) return empty("run_uncertain");
  const { from, to } = input.window;
  let inScope = 0;
  let keptUncertainDate = 0;
  let keptLocallyModified = 0;
  let absentPast = 0;
  const remove: string[] = [];
  for (const r of input.stored) {
    if (r.source !== "clwrota") continue;
    if (r.session_date < from || r.session_date > to) continue;
    if (!input.observedDates.has(r.session_date)) continue;
    inScope++;
    if (!r.clwrota_external_id || input.feedKeys.has(r.clwrota_external_id)) continue;
    if (r.locally_modified) {
      keptLocallyModified++;
      continue;
    }
    if (input.uncertainDates.has(r.session_date)) {
      keptUncertainDate++;
      continue;
    }
    if (r.session_date < input.notBefore) {
      absentPast++;
      continue;
    }
    remove.push(r.id);
  }
  const limit = Math.max(
    input.minAllowed ?? REMOVAL_MIN_ALLOWED,
    Math.ceil(inScope * (input.maxFraction ?? REMOVAL_MAX_FRACTION)),
  );
  if (remove.length > limit) {
    return {
      remove: [],
      inScope,
      guard: "too_many",
      keptUncertainDate,
      keptLocallyModified,
      absentPast,
    };
  }
  return { remove, inScope, guard: "ok", keptUncertainDate, keptLocallyModified, absentPast };
}
