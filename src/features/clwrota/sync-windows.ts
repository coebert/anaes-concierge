/**
 * Per-run rota import date windows (import side, pending migration 0010).
 *
 * Every rota import run — including each slice of a chunked import — records:
 *   - the window it ASKED the feed for (requested_from/to);
 *   - the window its returned rows actually SPANNED inside that request
 *     (covered_from/to; ok/partial only);
 *   - its outcome: ok | partial | empty | failed (see classifySyncOutcome).
 * No error text is stored (import errors can contain names). Nothing is
 * back-filled: dates before tracking starts read as "not tracked".
 * A missing table (migration not applied) is reported as not_installed and
 * never fails the import.
 */
import { normaliseDate, pick } from "./parsing";

export const SYNC_WINDOWS_TABLE = "clwrota_sync_windows";

export type SyncOutcome = "ok" | "partial" | "empty" | "failed";

export interface SyncWindowRecord {
  started_at: string;
  finished_at: string;
  requested_from: string;
  requested_to: string;
  covered_from: string | null;
  covered_to: string | null;
  outcome: SyncOutcome;
  explicit_window: boolean;
  rows_in_window: number;
  rows_skipped: number;
  write_errors: number;
}

const DAY = 86_400_000;
function isoDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The window a run asks for: explicit from..to, else today−back … today+ahead (UTC). */
export function resolveRequestedWindow(input: {
  from?: string;
  to?: string;
  daysBack: number;
  daysAhead: number;
  now: Date;
}): { from: string; to: string; explicit: boolean } {
  if (input.from && input.to) return { from: input.from, to: input.to, explicit: true };
  const today = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate(),
  );
  return {
    from: isoDay(today - input.daysBack * DAY),
    to: isoDay(today + input.daysAhead * DAY),
    explicit: false,
  };
}

/** First/last row date the feed returned, clipped to the requested window. */
export function coveredRange(
  rows: ReadonlyArray<Record<string, unknown>>,
  requested: { from: string; to: string },
): { from: string; to: string } | null {
  let lo: string | null = null;
  let hi: string | null = null;
  for (const r of rows) {
    const d = normaliseDate(pick(r, ["date", "session_date", "Date", "rota_date", "day"]) ?? null);
    if (!d || d < requested.from || d > requested.to) continue;
    if (lo === null || d < lo) lo = d;
    if (hi === null || d > hi) hi = d;
  }
  return lo && hi ? { from: lo, to: hi } : null;
}

/**
 * Conservative outcome:
 *   failed  — the run threw (fetch/parse/import error);
 *   empty   — no rows for the window (or none with a date inside it);
 *   partial — any row failed to write: the whole window is suspect;
 *   ok      — every row processed without a write error (rows the import
 *             deliberately skipped by rule are counted, not hidden).
 */
export function classifySyncOutcome(input: {
  threw: boolean;
  rowsInWindow: number;
  writeErrors: number;
  covered: { from: string; to: string } | null;
}): SyncOutcome {
  if (input.threw) return "failed";
  if (input.rowsInWindow === 0 || !input.covered) return "empty";
  if (input.writeErrors > 0) return "partial";
  return "ok";
}

export function buildSyncWindowRecord(input: {
  startedAt: Date;
  finishedAt: Date;
  requested: { from: string; to: string; explicit: boolean };
  threw: boolean;
  rows: ReadonlyArray<Record<string, unknown>>;
  skipped: number;
  writeErrors: number;
}): SyncWindowRecord {
  const covered = input.threw ? null : coveredRange(input.rows, input.requested);
  const outcome = classifySyncOutcome({
    threw: input.threw,
    rowsInWindow: input.rows.length,
    writeErrors: input.writeErrors,
    covered,
  });
  const keepCovered = outcome === "ok" || outcome === "partial";
  return {
    started_at: input.startedAt.toISOString(),
    finished_at: new Date(
      Math.max(input.finishedAt.getTime(), input.startedAt.getTime()),
    ).toISOString(),
    requested_from: input.requested.from,
    requested_to: input.requested.to,
    covered_from: keepCovered && covered ? covered.from : null,
    covered_to: keepCovered && covered ? covered.to : null,
    outcome,
    explicit_window: input.requested.explicit,
    rows_in_window: outcome === "empty" || outcome === "failed" ? 0 : input.rows.length,
    rows_skipped: Math.max(0, input.skipped),
    write_errors: outcome === "partial" ? Math.max(1, input.writeErrors) : 0,
  };
}

type DbError = { code?: string; message?: string } | null;
export interface SyncWindowClient {
  from(table: string): {
    insert(row: SyncWindowRecord): PromiseLike<{ error: DbError }>;
  };
}

export function isMissingSyncWindowsTable(e: DbError): boolean {
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /schema cache/i.test(e.message ?? "") && /clwrota_sync_windows/.test(e.message ?? "");
}

export type SyncWindowPersistResult =
  | { status: "ok" }
  | { status: "not_installed" }
  | { status: "error"; message: string };

export async function persistSyncWindow(
  client: SyncWindowClient,
  record: SyncWindowRecord,
): Promise<SyncWindowPersistResult> {
  try {
    const { error } = await client.from(SYNC_WINDOWS_TABLE).insert(record);
    if (!error) return { status: "ok" };
    if (isMissingSyncWindowsTable(error)) return { status: "not_installed" };
    return { status: "error", message: error.message ?? "insert failed" };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
