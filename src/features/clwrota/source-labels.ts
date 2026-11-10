/**
 * CLWRota list-title / list-note capture (import side).
 *
 * The Central API rota report is one row per rostered person. Each row of a
 * theatre list carries the list-level fields we request in
 * `ensureRotaReportFields`:
 *   - `slot_titles`            — the list title shown in the rota grid
 *   - `slot_notes`             — the list-level note
 *   - `place.additional_info`  — a note on the place (for example "Off site")
 * A value may be a string or (where the report supplies several) an array.
 *
 * These are kept SEPARATELY and AS SUPPLIED (trimmed only) on the restricted
 * relation `theatre_session_source_labels`, independent of:
 *   - `theatre_sessions.surgical_consultant` (legacy single title — still
 *     written by the import exactly as before),
 *   - `theatre_sessions.notes` (coordinator note — never written here),
 *   - `rota_assignments.notes` (first-non-empty assignment note — unchanged).
 *
 * Privacy: the raw values are potentially sensitive. They are written only
 * by the service-role import and are never logged, returned in sync results,
 * sent to the assistant or rendered. Browser callers receive derived signals
 * (tags / has-title / blank status) through
 * `get_theatre_session_label_signals`.
 *
 * Repeated / partial imports and removals:
 *   - Values from every row of the same session in one run are unioned and
 *     de-duplicated (case/whitespace-insensitive, first spelling kept).
 *   - A session date is "complete" when no row on that date was skipped for
 *     a reason that could hide a list row (unparseable session, missing
 *     external id, unmatched staff). On a complete date the run's values
 *     REPLACE the stored ones — so a title removed in the source is cleared
 *     (confirmed removal) and a re-run is idempotent.
 *   - On an incomplete date the stored values are kept and merged with the
 *     new ones, and the record is marked `evidence_complete = false`.
 *   - Sessions with no rows in this run are not touched at all.
 */
import {
  detectProcedureTags,
  PROCEDURE_TAGS,
  TAG_SCAN_MAX_CHARS,
  type ProcedureTag,
} from "@/features/audit/procedure-tags";

export const SOURCE_LABEL_TABLE = "theatre_session_source_labels";
export const SOURCE_TITLE_KEYS = [
  "slot_titles",
  "consultant",
  "surgeon",
  "surgical_consultant",
  "Consultant",
] as const;
export const SOURCE_NOTE_KEYS = ["slot_notes"] as const;
export const SOURCE_PLACE_NOTE_KEYS = ["place.additional_info"] as const;
export const MAX_VALUES_PER_FIELD = 20;
export const MAX_VALUE_CHARS = 2000;

export interface RowSourceLabels {
  titles: string[];
  notes: string[];
  placeNotes: string[];
}

function readPath(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key];
  if (!key.includes(".")) return undefined;
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, row);
}

function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim()] : []));
  return [];
}

/** Every non-empty string supplied under any of `keys` (string or array). */
export function pickAllStrings(row: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) out.push(...stringsOf(readPath(row, k)));
  return out;
}

export function extractRowSourceLabels(row: Record<string, unknown>): RowSourceLabels {
  return {
    titles: pickAllStrings(row, SOURCE_TITLE_KEYS),
    notes: pickAllStrings(row, SOURCE_NOTE_KEYS),
    placeNotes: pickAllStrings(row, SOURCE_PLACE_NOTE_KEYS),
  };
}

const dedupeKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Ordered, case/whitespace-insensitive distinct set; first spelling wins. */
class DistinctValues {
  private readonly map = new Map<string, string>();
  constructor(initial: readonly string[] = []) {
    for (const v of initial) this.add(v);
  }
  add(v: string) {
    const t = v.trim();
    if (!t) return;
    const k = dedupeKey(t);
    if (!this.map.has(k)) this.map.set(k, t);
  }
  values(): string[] {
    return [...this.map.values()];
  }
}

interface Collected {
  date: string;
  rows: number;
  titles: DistinctValues;
  notes: DistinctValues;
  placeNotes: DistinctValues;
}

export class SourceLabelCollector {
  private readonly byKey = new Map<string, Collected>();
  private readonly uncertainDates = new Set<string>();
  private globallyUncertain = false;

  /** One imported row that resolved to theatre session `sessionKey`. */
  observe(sessionKey: string, date: string, labels: RowSourceLabels) {
    let c = this.byKey.get(sessionKey);
    if (!c) {
      c = {
        date,
        rows: 0,
        titles: new DistinctValues(),
        notes: new DistinctValues(),
        placeNotes: new DistinctValues(),
      };
      this.byKey.set(sessionKey, c);
    }
    c.rows += 1;
    for (const v of labels.titles) c.titles.add(v);
    for (const v of labels.notes) c.notes.add(v);
    for (const v of labels.placeNotes) c.placeNotes.add(v);
  }

  /** A row was skipped in a way that could hide a list row on `date`. */
  markUncertain(date: string | null) {
    if (date) this.uncertainDates.add(date);
    else this.globallyUncertain = true;
  }

  isComplete(date: string): boolean {
    return !this.globallyUncertain && !this.uncertainDates.has(date);
  }

  get size() {
    return this.byKey.size;
  }

  entries(): Array<[string, Collected]> {
    return [...this.byKey.entries()];
  }
}

export interface StoredSourceLabels {
  theatre_session_id: string;
  list_titles: string[];
  list_notes: string[];
  place_notes: string[];
}

/** Exactly the columns of the restricted relation the import writes. */
export interface SourceLabelRecord {
  theatre_session_id: string;
  list_titles: string[];
  list_notes: string[];
  place_notes: string[];
  title_tags: ProcedureTag[];
  note_tags: ProcedureTag[];
  scan_truncated: boolean;
  source_rows_seen: number;
  evidence_complete: boolean;
  last_seen_at: string;
}

const capValues = (vs: string[]) =>
  vs.slice(0, MAX_VALUES_PER_FIELD).map((v) => (v.length > MAX_VALUE_CHARS ? v.slice(0, MAX_VALUE_CHARS) : v));

function tagsOf(values: string[]): ProcedureTag[] {
  const set = new Set<ProcedureTag>();
  for (const v of values) for (const t of detectProcedureTags(v)) set.add(t);
  return PROCEDURE_TAGS.filter((t) => set.has(t));
}

export interface SourceLabelPlan {
  records: SourceLabelRecord[];
  /** Session keys whose id could not be resolved (session upsert failed). */
  unresolved: number;
  /** Session ids on incomplete dates (existing values must be merged). */
  mergeIds: string[];
}

/** Ids whose stored values must be loaded before planning (incomplete dates). */
export function idsNeedingExisting(
  collector: SourceLabelCollector,
  sessionIdByKey: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const [key, c] of collector.entries()) {
    const id = sessionIdByKey.get(key);
    if (id && !collector.isComplete(c.date)) out.push(id);
  }
  return out;
}

export function planSourceLabelWrites(input: {
  collector: SourceLabelCollector;
  sessionIdByKey: ReadonlyMap<string, string>;
  existing: ReadonlyMap<string, StoredSourceLabels>;
  nowIso: string;
}): SourceLabelPlan {
  const { collector, sessionIdByKey, existing, nowIso } = input;
  const records: SourceLabelRecord[] = [];
  const mergeIds: string[] = [];
  let unresolved = 0;
  for (const [key, c] of collector.entries()) {
    const id = sessionIdByKey.get(key);
    if (!id) {
      unresolved++;
      continue;
    }
    const complete = collector.isComplete(c.date);
    const prior = complete ? undefined : existing.get(id);
    if (!complete) mergeIds.push(id);
    const merge = (priorVals: string[] | undefined, now: DistinctValues) => {
      const d = new DistinctValues(priorVals ?? []);
      for (const v of now.values()) d.add(v);
      return capValues(d.values());
    };
    const list_titles = merge(prior?.list_titles, c.titles);
    const list_notes = merge(prior?.list_notes, c.notes);
    const place_notes = merge(prior?.place_notes, c.placeNotes);
    records.push({
      theatre_session_id: id,
      list_titles,
      list_notes,
      place_notes,
      title_tags: tagsOf(list_titles),
      note_tags: tagsOf(list_notes),
      scan_truncated: [...list_titles, ...list_notes].some((v) => v.length > TAG_SCAN_MAX_CHARS),
      source_rows_seen: c.rows,
      evidence_complete: complete,
      last_seen_at: nowIso,
    });
  }
  records.sort((a, b) => a.theatre_session_id.localeCompare(b.theatre_session_id));
  return { records, unresolved, mergeIds };
}

// ───────────────────────────── Persistence ─────────────────────────────

type DbError = { code?: string; message?: string } | null;
interface SelectChain {
  in(col: string, ids: string[]): PromiseLike<{ data: StoredSourceLabels[] | null; error: DbError }>;
}
/** Minimal untyped view of the service-role client (the relation is not in the generated types until the migration is applied). */
export interface SourceLabelClient {
  from(table: string): {
    select(cols: string): SelectChain;
    upsert(
      rows: SourceLabelRecord[],
      opts: { onConflict: string },
    ): PromiseLike<{ error: DbError }>;
  };
}

export function isMissingRelationError(e: DbError): boolean {
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /schema cache/i.test(e.message ?? "") && /theatre_session_source_labels/.test(e.message ?? "");
}

export type PersistResult =
  | { status: "ok"; written: number; unresolved: number; merged: number }
  | { status: "not_installed"; written: 0; unresolved: number; merged: 0 }
  | { status: "error"; written: number; unresolved: number; merged: number; message: string };

/**
 * Writes the plan for one run. Never logs or returns raw values; error
 * messages are the database's own (which do not echo row data).
 */
export async function persistSourceLabels(
  client: SourceLabelClient,
  collector: SourceLabelCollector,
  sessionIdByKey: ReadonlyMap<string, string>,
  opts: { nowIso: string; inChunk?: number; upsertChunk?: number },
): Promise<PersistResult> {
  const inChunk = opts.inChunk ?? 200;
  const upsertChunk = opts.upsertChunk ?? 500;
  const existing = new Map<string, StoredSourceLabels>();
  const needExisting = idsNeedingExisting(collector, sessionIdByKey);
  for (let i = 0; i < needExisting.length; i += inChunk) {
    const ids = needExisting.slice(i, i + inChunk);
    const { data, error } = await client
      .from(SOURCE_LABEL_TABLE)
      .select("theatre_session_id,list_titles,list_notes,place_notes")
      .in("theatre_session_id", ids);
    if (error) {
      if (isMissingRelationError(error)) {
        return { status: "not_installed", written: 0, unresolved: 0, merged: 0 };
      }
      // Without the stored values a merge could drop real labels: stop.
      return {
        status: "error",
        written: 0,
        unresolved: 0,
        merged: 0,
        message: `existing source labels: ${error.message ?? "lookup failed"}`,
      };
    }
    for (const r of data ?? []) existing.set(r.theatre_session_id, r);
  }
  const plan = planSourceLabelWrites({ collector, sessionIdByKey, existing, nowIso: opts.nowIso });
  let written = 0;
  for (let i = 0; i < plan.records.length; i += upsertChunk) {
    const chunk = plan.records.slice(i, i + upsertChunk);
    const { error } = await client
      .from(SOURCE_LABEL_TABLE)
      .upsert(chunk, { onConflict: "theatre_session_id" });
    if (error) {
      if (written === 0 && isMissingRelationError(error)) {
        return { status: "not_installed", written: 0, unresolved: plan.unresolved, merged: 0 };
      }
      return {
        status: "error",
        written,
        unresolved: plan.unresolved,
        merged: plan.mergeIds.length,
        message: `source labels chunk ${i}-${i + chunk.length}: ${error.message ?? "upsert failed"}`,
      };
    }
    written += chunk.length;
  }
  return { status: "ok", written, unresolved: plan.unresolved, merged: plan.mergeIds.length };
}
