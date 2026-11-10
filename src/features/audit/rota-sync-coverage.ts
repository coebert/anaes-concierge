/**
 * Per-week rota IMPORT coverage and freshness (browser side).
 *
 * Reads the derived `get_rota_sync_week_coverage` summary (pending migration
 * 0010; the raw per-run table is service-only). This is a different question
 * from the week's publication state (`rota-week-status.ts`):
 *   - coverage:   how many days of the week a COMPLETE import has confirmed;
 *   - freshness:  when every day was last confirmed (last known good) and
 *                 whether that is older than IMPORT_STALE_AFTER_HOURS;
 *   - problems:   the newest import attempt touching the week was partial,
 *                 empty or failed — the last known good time is still shown;
 *   - not tracked: no run touched the week since tracking began. Nothing
 *                 before tracking is inferred.
 * Each chunk of a chunked import is its own run, so a week only counts as
 * complete when every one of its days was covered by a clean run.
 */
import { supabase } from "@/integrations/supabase/client";
import { isoWeekStart } from "@/features/clwrota/week-status-core";

export const IMPORT_STALE_AFTER_HOURS = 48;

export type ImportCapture = "available" | "not_installed";
export type ImportAttemptOutcome = "ok" | "partial" | "empty" | "failed";
export type ImportWeekState =
  | "current"
  | "stale"
  | "attempt_problem"
  | "incomplete"
  | "not_tracked";

export interface SyncCoverageRow {
  week_start: string;
  days_total: number;
  days_ok: number;
  days_partial_only: number;
  days_latest_not_ok: number;
  last_full_ok_at: string | null;
  newest_ok_at: string | null;
  latest_attempt_at: string | null;
  latest_attempt_outcome: string | null;
  tracking_since: string | null;
}

export interface ImportWeekEntry {
  weekStart: string;
  state: ImportWeekState;
  daysTotal: number;
  daysOk: number;
  /** Days whose newest attempt wasn't clean. */
  daysProblem: number;
  /** When every day of the week was last confirmed by a clean import. */
  lastKnownGoodAt: string | null;
  latestAttemptAt: string | null;
  latestAttemptOutcome: ImportAttemptOutcome | null;
  /** The week ended before import tracking started. */
  beforeTracking: boolean;
}

export interface ImportCoverageTimeline {
  capture: ImportCapture;
  trackingSince: string | null;
  weeks: ImportWeekEntry[];
  byWeek: Map<string, ImportWeekEntry>;
}

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "partial", "empty", "failed"]);

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function classifyImportWeek(
  r: SyncCoverageRow | undefined,
  now: Date,
): Omit<ImportWeekEntry, "weekStart" | "beforeTracking"> {
  const empty = {
    daysTotal: r?.days_total ?? 7,
    daysOk: 0,
    daysProblem: 0,
    lastKnownGoodAt: null,
    latestAttemptAt: null,
    latestAttemptOutcome: null,
  };
  if (!r) return { state: "not_tracked", ...empty };
  const outcome =
    r.latest_attempt_outcome && OUTCOMES.has(r.latest_attempt_outcome)
      ? (r.latest_attempt_outcome as ImportAttemptOutcome)
      : null;
  const base = {
    daysTotal: r.days_total,
    daysOk: Math.max(0, Math.min(r.days_ok, r.days_total)),
    daysProblem: Math.max(0, r.days_latest_not_ok),
    lastKnownGoodAt: r.days_ok >= r.days_total ? r.last_full_ok_at : null,
    latestAttemptAt: r.latest_attempt_at,
    // An unrecognised outcome is treated as a problem, never as ok.
    latestAttemptOutcome: r.latest_attempt_outcome && !outcome ? "failed" : outcome,
  };
  if (!r.latest_attempt_at && r.days_ok === 0) return { state: "not_tracked", ...base };
  if (base.daysProblem > 0 || (base.latestAttemptOutcome && base.latestAttemptOutcome !== "ok"))
    return { state: "attempt_problem", ...base };
  if (base.daysOk < r.days_total || !base.lastKnownGoodAt) return { state: "incomplete", ...base };
  const age = now.getTime() - Date.parse(base.lastKnownGoodAt);
  return {
    state:
      Number.isFinite(age) && age <= IMPORT_STALE_AFTER_HOURS * 3_600_000 ? "current" : "stale",
    ...base,
  };
}

export function buildImportCoverageTimeline(input: {
  rangeStart: string;
  rangeEnd: string;
  rows: SyncCoverageRow[];
  capture: ImportCapture;
  now: Date;
}): ImportCoverageTimeline {
  const { rangeStart, rangeEnd, rows, capture, now } = input;
  const byStart = new Map(rows.map((r) => [r.week_start, r]));
  const trackingSince = rows.find((r) => r.tracking_since)?.tracking_since ?? null;
  const weeks: ImportWeekEntry[] = [];
  for (let w = isoWeekStart(rangeStart); w <= rangeEnd; w = addDays(w, 7)) {
    const r = capture === "available" ? byStart.get(w) : undefined;
    const c = classifyImportWeek(r, now);
    weeks.push({
      weekStart: w,
      ...c,
      beforeTracking:
        c.state === "not_tracked" && !!trackingSince && addDays(w, 6) < trackingSince.slice(0, 10),
    });
  }
  return { capture, trackingSince, weeks, byWeek: new Map(weeks.map((e) => [e.weekStart, e])) };
}

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

export function importWeekLabel(e: ImportWeekEntry): string {
  switch (e.state) {
    case "current":
      return "Imported";
    case "stale":
      return "Import out of date";
    case "incomplete":
      return `${e.daysOk}/${e.daysTotal} days imported`;
    case "attempt_problem":
      return e.latestAttemptOutcome === "failed"
        ? "Last import failed"
        : e.latestAttemptOutcome === "empty"
          ? "Last import empty"
          : "Last import partial";
    case "not_tracked":
      return "Import not tracked";
  }
}

export function importWeekHelp(e: ImportWeekEntry): string {
  const lkg = e.lastKnownGoodAt
    ? `Last known good: every day confirmed by ${fmtDay(e.lastKnownGoodAt)}.`
    : "No complete import of every day yet.";
  switch (e.state) {
    case "current":
      return `Every day of this week was confirmed by a complete import. ${lkg}`;
    case "stale":
      return `Every day was imported, but the newest complete confirmation is over ${IMPORT_STALE_AFTER_HOURS} hours old. ${lkg}`;
    case "incomplete":
      return `Only ${e.daysOk} of ${e.daysTotal} days have been confirmed by a complete import; the rest weren't in any clean import's rows.`;
    case "attempt_problem":
      return `The newest import for ${e.daysProblem || "some"} day(s) of this week didn't complete cleanly, so later changes may be missing. ${lkg}`;
    case "not_tracked":
      return e.beforeTracking
        ? "This week ended before import tracking started, so its import history is unknown."
        : "No tracked import has covered this week yet.";
  }
}

type RpcError = { code?: string; message?: string } | null;
interface CoverageRpc {
  rpc(
    fn: "get_rota_sync_week_coverage",
    args: { p_from: string; p_to: string },
  ): PromiseLike<{ data: SyncCoverageRow[] | null; error: RpcError }>;
}

export function isMissingCoverageFunction(e: RpcError): boolean {
  if (!e) return false;
  if (e.code === "PGRST202" || e.code === "42883") return true;
  return (
    /get_rota_sync_week_coverage/.test(e.message ?? "") &&
    /schema cache|could not find/i.test(e.message ?? "")
  );
}

/**
 * One bounded call (≤ 58 weekly rows for the ≤ 400-day window the function
 * accepts — far below the 1000-row API cap). More rows than weeks requested
 * means something is wrong, so it fails rather than truncating.
 */
export async function loadImportCoverage(
  rangeStart: string,
  rangeEnd: string,
  client: unknown = supabase,
): Promise<{ rows: SyncCoverageRow[]; capture: ImportCapture }> {
  const { data, error } = await (client as CoverageRpc).rpc("get_rota_sync_week_coverage", {
    p_from: rangeStart,
    p_to: rangeEnd,
  });
  if (error) {
    if (isMissingCoverageFunction(error)) return { rows: [], capture: "not_installed" };
    throw new Error(
      `Rota import coverage couldn't be loaded: ${error.message ?? "request failed"}`,
    );
  }
  const rows = data ?? [];
  let expected = 0;
  for (let w = isoWeekStart(rangeStart); w <= rangeEnd; w = addDays(w, 7)) expected += 1;
  if (rows.length > expected) {
    throw new Error(
      `Rota import coverage returned ${rows.length} weeks for a ${expected}-week window.`,
    );
  }
  return { rows, capture: "available" };
}
