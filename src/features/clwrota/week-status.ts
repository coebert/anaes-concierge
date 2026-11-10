/**
 * CLWRota week rota status (import side).
 *
 * Source: the `rota_status` field of the configured Central API
 * `assignments` query. Verified (field-list + aggregate value check, no row
 * data kept) to take the values "Published", "Setup" and "Not setup", and to
 * be uniform within an ISO week. The CLWRota weekly view labels may differ
 * (e.g. it may show "Draft"); we keep the feed's own term and never map it.
 *
 * Rules:
 *   - A week's status is recorded ONLY from rows the feed actually returned
 *     for that week. A week with no rows is never written, so missing rows
 *     can never read as "published" or "not set up".
 *   - Several distinct statuses in one week → "mixed"; rows with no status
 *     → "unknown"; an unrecognised value → "other" (raw value kept if it is a
 *     short plain word, so a new source state stays visible).
 *   - `assignments.state` ("planned" / "actual") is counted per week for
 *     provenance only. "actual" rows also occur in future weeks, so it is NOT
 *     delivered work and must never be used as planned-vs-delivered.
 *   - Times recorded are when the import OBSERVED a status, not when anyone
 *     published the rota; no publication actor is read.
 */
import { pick } from "./parsing";

export const WEEK_STATUS_TABLE = "clwrota_week_status";

export type WeekStatusCode = "published" | "setup" | "not_setup" | "mixed" | "unknown" | "other";

const SAFE_RAW = /^[A-Za-z][A-Za-z _-]{0,39}$/;

/** Feed value → code. `null` for blank/absent. */
export function normaliseRotaStatus(raw: unknown): Exclude<WeekStatusCode, "mixed" | "unknown"> | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!k) return null;
  if (k === "published") return "published";
  if (k === "setup" || k === "set up") return "setup";
  if (k === "not setup" || k === "not set up") return "not_setup";
  return "other";
}

/** Monday (ISO week start) of a yyyy-mm-dd date, as yyyy-mm-dd. */
export function isoWeekStart(dateIso: string): string {
  const [y, m, d] = dateIso.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay(); // 0 Sun … 6 Sat
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

interface WeekAcc {
  rows: number;
  codes: Set<Exclude<WeekStatusCode, "mixed" | "unknown">>;
  raw: Map<string, string>;
  planned: number;
  actual: number;
  otherState: number;
  dates: Set<string>;
}

export class WeekStatusCollector {
  private readonly weeks = new Map<string, WeekAcc>();

  observe(dateIso: string, rotaStatusRaw: unknown, stateRaw: unknown) {
    const wk = isoWeekStart(dateIso);
    let a = this.weeks.get(wk);
    if (!a) {
      a = { rows: 0, codes: new Set(), raw: new Map(), planned: 0, actual: 0, otherState: 0, dates: new Set() };
      this.weeks.set(wk, a);
    }
    a.rows += 1;
    a.dates.add(dateIso.slice(0, 10));
    const code = normaliseRotaStatus(rotaStatusRaw);
    if (code) {
      a.codes.add(code);
      const t = String(rotaStatusRaw).trim();
      if (SAFE_RAW.test(t) && a.raw.size < 5 && !a.raw.has(t.toLowerCase())) a.raw.set(t.toLowerCase(), t);
    }
    const st = typeof stateRaw === "string" ? stateRaw.trim().toLowerCase() : "";
    if (st === "planned") a.planned += 1;
    else if (st === "actual") a.actual += 1;
    else a.otherState += 1;
  }

  /** Convenience for a raw feed row. */
  observeRow(dateIso: string, row: Record<string, unknown>) {
    this.observe(dateIso, pick(row, ["rota_status"]), pick(row, ["state"]));
  }

  get size() {
    return this.weeks.size;
  }

  entries(): Array<[string, WeekAcc]> {
    return [...this.weeks.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
}

export interface StoredWeekStatus {
  week_start: string;
  status_code: WeekStatusCode;
  first_observed_at: string;
  status_since: string;
  previous_status_code: WeekStatusCode | null;
}

/** Exactly the columns of `clwrota_week_status` the import writes. */
export interface WeekStatusRecord {
  week_start: string;
  status_code: WeekStatusCode;
  source_values: string[];
  rows_seen: number;
  dates_seen: number;
  planned_rows: number;
  actual_rows: number;
  other_state_rows: number;
  observed_at: string;
  first_observed_at: string;
  status_since: string;
  previous_status_code: WeekStatusCode | null;
}

export function planWeekStatusWrites(input: {
  collector: WeekStatusCollector;
  existing: ReadonlyMap<string, StoredWeekStatus>;
  nowIso: string;
}): WeekStatusRecord[] {
  const { collector, existing, nowIso } = input;
  return collector.entries().map(([week_start, a]) => {
    const status_code: WeekStatusCode =
      a.codes.size === 0 ? "unknown" : a.codes.size > 1 ? "mixed" : [...a.codes][0];
    const prior = existing.get(week_start);
    const changed = !prior || prior.status_code !== status_code;
    return {
      week_start,
      status_code,
      source_values: [...a.raw.values()].sort(),
      rows_seen: a.rows,
      dates_seen: a.dates.size,
      planned_rows: a.planned,
      actual_rows: a.actual,
      other_state_rows: a.otherState,
      observed_at: nowIso,
      first_observed_at: prior?.first_observed_at ?? nowIso,
      status_since: changed ? nowIso : prior.status_since,
      previous_status_code: changed ? (prior?.status_code ?? null) : prior.previous_status_code,
    };
  });
}

type DbError = { code?: string; message?: string } | null;
export interface WeekStatusClient {
  from(table: string): {
    select(cols: string): {
      in(col: string, keys: string[]): PromiseLike<{ data: StoredWeekStatus[] | null; error: DbError }>;
    };
    upsert(rows: WeekStatusRecord[], opts: { onConflict: string }): PromiseLike<{ error: DbError }>;
  };
}

export function isMissingWeekStatusTable(e: DbError): boolean {
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /schema cache/i.test(e.message ?? "") && /clwrota_week_status/.test(e.message ?? "");
}

export type WeekStatusPersistResult =
  | { status: "ok"; written: number }
  | { status: "not_installed"; written: 0 }
  | { status: "error"; written: number; message: string };

export async function persistWeekStatus(
  client: WeekStatusClient,
  collector: WeekStatusCollector,
  opts: { nowIso: string; inChunk?: number; upsertChunk?: number },
): Promise<WeekStatusPersistResult> {
  const weeks = collector.entries().map(([w]) => w);
  if (weeks.length === 0) return { status: "ok", written: 0 };
  const inChunk = opts.inChunk ?? 200;
  const upsertChunk = opts.upsertChunk ?? 500;
  const existing = new Map<string, StoredWeekStatus>();
  for (let i = 0; i < weeks.length; i += inChunk) {
    const { data, error } = await client
      .from(WEEK_STATUS_TABLE)
      .select("week_start,status_code,first_observed_at,status_since,previous_status_code")
      .in("week_start", weeks.slice(i, i + inChunk));
    if (error) {
      if (isMissingWeekStatusTable(error)) return { status: "not_installed", written: 0 };
      // Without prior rows we'd reset first-seen / since times: stop.
      return { status: "error", written: 0, message: `existing week status: ${error.message ?? "lookup failed"}` };
    }
    for (const r of data ?? []) existing.set(r.week_start, r);
  }
  const records = planWeekStatusWrites({ collector, existing, nowIso: opts.nowIso });
  let written = 0;
  for (let i = 0; i < records.length; i += upsertChunk) {
    const chunk = records.slice(i, i + upsertChunk);
    const { error } = await client.from(WEEK_STATUS_TABLE).upsert(chunk, { onConflict: "week_start" });
    if (error) {
      if (written === 0 && isMissingWeekStatusTable(error)) return { status: "not_installed", written: 0 };
      return { status: "error", written, message: `week status chunk ${i}: ${error.message ?? "upsert failed"}` };
    }
    written += chunk.length;
  }
  return { status: "ok", written };
}
