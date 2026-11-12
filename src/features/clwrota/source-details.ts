/**
 * Per-assignment CLWRota source details (import side).
 *
 * `rota_assignments.notes` holds one derived string (first of slot_notes /
 * place name, or a "Tutorial:" / "Non-patient-facing:" rewrite), and the
 * original list title, list note and place note are kept only for rows linked
 * to a theatre list (`theatre_session_source_labels`). For every other
 * working row — on-call, ICU, ward, clinic, SPA, admin, unmatched places —
 * the feed's own title/note/place note and its typed times were dropped.
 *
 * This module keeps them per stored assignment, separately and as supplied
 * (trimmed only), on the restricted relation `rota_assignment_source_details`
 * (service_role only, keyed by the assignment's CLWRota key; deleted with
 * the assignment). Feed rows for the same half that could not be stored
 * because only one row per person per half is allowed are kept as
 * `collapsed_rows` on the stored assignment instead of being lost.
 *
 * Never captured: person contact/HR fields (email, mobile, GMC, last login,
 * pay), extra-claim payment details. Raw values are never logged or
 * returned — only counts.
 */
import { pickAllStrings } from "./source-labels";

export const SOURCE_DETAILS_TABLE = "rota_assignment_source_details";
export const MAX_DETAIL_VALUES = 20;
export const MAX_DETAIL_CHARS = 2000;
export const MAX_COLLAPSED_ROWS = 20;

export interface AssignmentSourceDetails {
  slot_titles: string[];
  slot_notes: string[];
  slot_speciality: string | null;
  place_name: string | null;
  place_local_id: string | null;
  place_category: string | null;
  place_notes: string[];
  session_label: string | null;
  role_name: string | null;
  role_category: string | null;
  assignment_type: string | null;
  extra_type_name: string | null;
  extra_type_description: string | null;
  source_state: string | null;
  source_rota_status: string | null;
  start_time: string | null;
  end_time: string | null;
  duration: string | null;
  pa_value: number | null;
  /** True when a value or list had to be cut to the storage limits. */
  values_truncated: boolean;
}

export interface CollapsedSourceRow {
  duty_type: string;
  reason: string;
  slot_titles: string[];
  slot_notes: string[];
  place_name: string | null;
  place_notes: string[];
  role_name: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface SourceDetailRecord extends AssignmentSourceDetails {
  clwrota_external_id: string;
  collapsed_rows: CollapsedSourceRow[];
  last_seen_at: string;
}

function readPath(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key];
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, row);
}

function scalar(row: Record<string, unknown>, key: string): string | null {
  const v = readPath(row, key);
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
function timestamp(row: Record<string, unknown>, key: string): string | null {
  const s = scalar(row, key);
  if (!s || !ISO_TS.test(s) || Number.isNaN(Date.parse(s))) return null;
  return s;
}
function duration(row: Record<string, unknown>): string | null {
  const s = scalar(row, "duration");
  return s && /^\d{1,3}:[0-5]\d:[0-5]\d$/.test(s) ? s : null;
}
function paValue(row: Record<string, unknown>): number | null {
  const v = readPath(row, "pa_value");
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function extractAssignmentSourceDetails(
  row: Record<string, unknown>,
): AssignmentSourceDetails {
  let truncated = false;
  const cap = (v: string | null) => {
    if (v && v.length > MAX_DETAIL_CHARS) {
      truncated = true;
      return v.slice(0, MAX_DETAIL_CHARS);
    }
    return v;
  };
  const list = (keys: readonly string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of pickAllStrings(row, keys)) {
      const k = v.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(cap(v)!);
    }
    if (out.length > MAX_DETAIL_VALUES) truncated = true;
    return out.slice(0, MAX_DETAIL_VALUES);
  };
  const d: AssignmentSourceDetails = {
    slot_titles: list(["slot_titles"]),
    slot_notes: list(["slot_notes"]),
    slot_speciality: cap(scalar(row, "slot_speciality")),
    place_name: cap(scalar(row, "place.name")),
    place_local_id: cap(scalar(row, "place.local_id")),
    place_category: cap(scalar(row, "place_category.name")),
    place_notes: list(["place.additional_info"]),
    session_label: cap(scalar(row, "session.rota_label") ?? scalar(row, "shift.rota_label")),
    role_name: cap(scalar(row, "role.name")),
    role_category: cap(scalar(row, "role_category.name")),
    assignment_type: cap(scalar(row, "assignment_type.name")),
    extra_type_name: cap(scalar(row, "extra_type.name")),
    extra_type_description: cap(scalar(row, "extra_type.description")),
    source_state: cap(scalar(row, "state")),
    source_rota_status: cap(scalar(row, "rota_status")),
    start_time: timestamp(row, "start_time"),
    end_time: timestamp(row, "end_time"),
    duration: duration(row),
    pa_value: paValue(row),
    values_truncated: false,
  };
  d.values_truncated = truncated;
  return d;
}

export interface DetailDraft {
  clwrota_external_id: string;
  duty_type: string;
  source_details?: AssignmentSourceDetails;
}

/**
 * One record per stored assignment. `dropped` are the dedupe losers; each is
 * attached to the assignment that was stored for its half.
 */
export function buildSourceDetailRecords<T extends DetailDraft>(input: {
  stored: readonly T[];
  dropped: ReadonlyArray<{ dropped: T; kept: T; reason: string }>;
  nowIso: string;
}): { records: SourceDetailRecord[]; collapsedAttached: number; collapsedOverflow: number } {
  const collapsed = new Map<string, CollapsedSourceRow[]>();
  let attached = 0;
  let overflow = 0;
  for (const x of input.dropped) {
    const d = x.dropped.source_details;
    if (!d) continue;
    const arr = collapsed.get(x.kept.clwrota_external_id) ?? [];
    if (arr.length >= MAX_COLLAPSED_ROWS) {
      overflow++;
      continue;
    }
    arr.push({
      duty_type: x.dropped.duty_type,
      reason: x.reason,
      slot_titles: d.slot_titles,
      slot_notes: d.slot_notes,
      place_name: d.place_name,
      place_notes: d.place_notes,
      role_name: d.role_name,
      start_time: d.start_time,
      end_time: d.end_time,
    });
    collapsed.set(x.kept.clwrota_external_id, arr);
    attached++;
  }
  const records: SourceDetailRecord[] = [];
  for (const a of input.stored) {
    if (!a.source_details) continue;
    records.push({
      ...a.source_details,
      clwrota_external_id: a.clwrota_external_id,
      collapsed_rows: collapsed.get(a.clwrota_external_id) ?? [],
      last_seen_at: input.nowIso,
    });
  }
  return { records, collapsedAttached: attached, collapsedOverflow: overflow };
}

type DbError = { code?: string; message?: string } | null;
/** Minimal untyped service-role client view (the relation is not in the generated types until the migration is applied). */
export interface SourceDetailsClient {
  from(table: string): {
    upsert(
      rows: SourceDetailRecord[],
      opts: { onConflict: string },
    ): PromiseLike<{ error: DbError }>;
  };
}

const isMissingRelation = (e: DbError) =>
  !!e &&
  (e.code === "42P01" ||
    e.code === "PGRST205" ||
    (/schema cache/i.test(e.message ?? "") &&
      /rota_assignment_source_details/.test(e.message ?? "")));

export type SourceDetailsResult =
  | { status: "ok"; written: number }
  | { status: "not_installed"; written: 0 }
  | { status: "error"; written: number; message: string };

export async function persistAssignmentSourceDetails(
  client: SourceDetailsClient,
  records: readonly SourceDetailRecord[],
  opts: { chunk?: number } = {},
): Promise<SourceDetailsResult> {
  const size = opts.chunk ?? 500;
  let written = 0;
  for (let i = 0; i < records.length; i += size) {
    const chunk = records.slice(i, i + size);
    const { error } = await client
      .from(SOURCE_DETAILS_TABLE)
      .upsert(chunk, { onConflict: "clwrota_external_id" });
    if (error) {
      if (written === 0 && isMissingRelation(error)) return { status: "not_installed", written: 0 };
      return {
        status: "error",
        written,
        message: `source details chunk ${i}-${i + chunk.length}: ${error.message ?? "upsert failed"}`,
      };
    }
    written += chunk.length;
  }
  return { status: "ok", written };
}
