// Auto-carved from clwrota.functions.ts (Phase 4a.ii split).
// Pure helpers: URL/window rewriters, CLWRota payload fetch/parse, and
// classifier/normaliser utilities. NO Supabase / secret dependencies.
import { RowsWrapperSchema, RotamapCentralApiSchema } from "./schemas";
export { RotamapCentralApiSchema };
export type { ClwRotaGenericRow, ParsedRowsResult } from "./schemas";
import { normaliseRotaLabelText } from "@/lib/clwrota-labels";

export function withRollingFutureWindow(rawUrl: string, monthsAhead = 12): string {
  try {
    const u = new URL(rawUrl);
    const params = u.searchParams;
    if (!params.has("start_date") && !params.has("end_date")) return rawUrl;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const minEnd = new Date(today);
    minEnd.setUTCMonth(minEnd.getUTCMonth() + monthsAhead);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const currentEndStr = params.get("end_date");
    const currentEnd = currentEndStr ? new Date(`${currentEndStr}T00:00:00Z`) : null;
    const newEnd =
      currentEnd && !Number.isNaN(currentEnd.getTime()) && currentEnd > minEnd
        ? currentEnd
        : minEnd;
    params.set("end_date", fmt(newEnd));

    const currentStartStr = params.get("start_date");
    const currentStart = currentStartStr ? new Date(`${currentStartStr}T00:00:00Z`) : null;
    if (currentStart && !Number.isNaN(currentStart.getTime()) && currentStart > newEnd) {
      params.set("start_date", fmt(today));
    }

    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * CLWRota leave_events report only returns the fields requested in the
 * `fields=` query param. Coordinators have historically configured the URL
 * with only cost/date metadata and no person identifier or leave-type
 * fields — making every returned row impossible to match to a profile and
 * silently dropping all rows. We always add the fields the sync needs.
 */
export function ensureLeaveReportFields(rawUrl: string): string {
  // CLWRota's `leave_events` endpoint supports person.*, leave_type.*,
  // leave_request.* and leave_submittal.* — but NOT a top-level
  // `status.name` or `reason`. Status lives on `leave_request.state`
  // (or `leave_submittal.state`); free-text on `leave_request.details`.
  // Requesting an unknown field returns 400 and aborts the whole sync.
  if (!rawUrl) return rawUrl;
  const required = [
    "start_time", "end_time", "date", "duration",
    "person.email", "person.local_id", "person.esr_employee_number",
    "person.first_name", "person.last_name", "person.rota_name",
    "leave_type.name",
    "leave_request.local_id", "leave_request.state",
    "leave_request.start_date", "leave_request.end_date",
    "leave_request.details",
    "leave_submittal.state",
  ];
  try {
    const u = new URL(rawUrl);
    const existing = u.searchParams.get("fields");
    const set = new Set(
      (existing ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    );
    for (const f of required) set.add(f);
    u.searchParams.set("fields", Array.from(set).join(","));
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Ensure the CLWRota rota/assignments report URL requests the fields that
 * carry tutorial labels in real Central API payloads. The missing sessions
 * were not in the generic `notes` field at all — they were mostly in
 * `slot_titles` / `place.name` (for example "Tutorial / SPA") and sometimes
 * `slot_notes`.
 */
export function ensureRotaReportFields(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  const required = ["notes", "slot_notes", "slot_titles", "place.name"];
  try {
    const u = new URL(rawUrl);
    const existing = u.searchParams.get("fields");
    if (!existing) return rawUrl; // no fields= means "all fields" — notes already included
    const set = new Set(
      existing.split(",").map((s) => s.trim()).filter(Boolean),
    );
    for (const f of required) set.add(f);
    u.searchParams.set("fields", Array.from(set).join(","));
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Force a CLWRota report URL's date window to a bounded operational range.
 *
 * The rota report can otherwise span 12+ months (every row of every
 * theatre + on-call assignment for the whole department), which causes
 * the upstream CLWRota fetch and the chunked Supabase upserts to exceed
 * the Worker's gateway timeout ("upstream timeout"). Historical rows
 * already synced into `rota_assignments` are preserved by the
 * non-destructive upsert path, so narrowing the live sync window is safe.
 */
export function clampDateWindow(
  rawUrl: string,
  { daysBack = 30, daysAhead = 120 }: { daysBack?: number; daysAhead?: number } = {},
): string {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has("start_date") && !u.searchParams.has("end_date")) {
      return rawUrl;
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - daysBack);
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + daysAhead);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    u.searchParams.set("start_date", fmt(start));
    u.searchParams.set("end_date", fmt(end));
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Force a CLWRota report URL to an explicit `from..to` date window
 * (YYYY-MM-DD). Used by chunked historical backfills so the caller can
 * walk a long range in Worker-sized slices.
 */
export function explicitDateWindow(
  rawUrl: string,
  from: string,
  to: string,
): string {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set("start_date", from);
    u.searchParams.set("end_date", to);
    return u.toString();
  } catch {
    return rawUrl;
  }
}




/**
 * True if the error/response indicates a transient upstream timeout or
 * temporary gateway failure that's worth retrying.
 */
function isTransientUpstreamError(status: number, body: string, err?: unknown): boolean {
  if (status === 408 || status === 502 || status === 503 || status === 504 || status === 524 || status === 522) {
    return true;
  }
  const haystack = `${body} ${err instanceof Error ? err.message : ""}`.toLowerCase();
  return (
    haystack.includes("upstream timeout") ||
    haystack.includes("gateway timeout") ||
    haystack.includes("etimedout") ||
    haystack.includes("econnreset") ||
    haystack.includes("network connection lost") ||
    haystack.includes("fetch failed")
  );
}

export async function fetchReportRaw(
  url: string,
  apiKey: string,
  { maxAttempts = 4, baseDelayMs = 1000 }: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<string> {
  const effectiveUrl = withRollingFutureWindow(url);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(effectiveUrl, {
        method: "GET",
        headers: { "X-Auth": apiKey, Accept: "application/json, text/csv;q=0.9" },
      });
      const text = await res.text();
      if (res.ok) return text;

      const transient = isTransientUpstreamError(res.status, text);
      const errMsg = `CLWRota report failed: ${res.status} ${text.slice(0, 200)}`;
      if (!transient || attempt === maxAttempts) {
        throw new Error(errMsg);
      }
      lastErr = new Error(errMsg);
    } catch (err) {
      // Network-level failure (fetch threw). Retry if transient.
      const transient = isTransientUpstreamError(0, "", err);
      if (!transient || attempt === maxAttempts) throw err;
      lastErr = err;
    }
    // Exponential backoff with jitter: 1s, 2s, 4s, 8s … capped at 15s.
    const delay = Math.min(15000, baseDelayMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    console.warn(
      `[clwrota] transient fetch failure on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
      lastErr instanceof Error ? lastErr.message : lastErr,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  // Unreachable, but keeps TS happy.
  throw lastErr instanceof Error ? lastErr : new Error("CLWRota report failed");
}


// Top-level JSON shape we can ingest: either an array of row objects, or an
// object that contains rows under a known wrapper key (Rotamap central_api,
// generic { data: [...] }, etc.). Validated permissively — individual row
// fields are picked downstream via pick() with fallbacks.
// Row-level and wrapper schemas live in `./schemas` — see there for the
// definitions of RotamapCentralApiSchema and RowsWrapperSchema.

/**
 * Defensively parse a CLWRota report body (JSON or CSV) into a row array.
 *
 * NEVER THROWS. A malformed upstream payload — invalid JSON, missing
 * `columns`/`rows`/`data`, wrong types at the top level, unexpected
 * nesting, or any runtime error during row zipping — yields
 * `{ rows: [], parseError: <human-readable reason> }`. Callers should log
 * `parseError` into `clwrota_sync_state.last_error` so admins see a clear
 * diagnostic instead of a generic stack trace.
 *
 * Returning a structured result (rather than throwing or silently
 * returning []) keeps the boundary explicit: every empty result can be
 * traced back to either "upstream returned nothing" (`parseError: null`)
 * or "upstream returned malformed data" (`parseError: "..."`).
 */
export function parseRows(text: string): { rows: Record<string, unknown>[]; parseError: string | null } {
  // Try JSON first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // CSV fallback — naive parse (no quoted commas). Good enough for Rotamap reports.
    try {
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        return {
          rows: [],
          parseError: text.trim().length === 0
            ? "Empty response body"
            : "Response is neither valid JSON nor a CSV with a header + ≥1 data row",
        };
      }
      const headers = lines[0].split(",").map((h) => h.trim());
      const rows = lines.slice(1).map((line) => {
        const cells = line.split(",");
        const obj: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          obj[h] = cells[i]?.trim() ?? "";
        });
        return obj;
      });
      return { rows, parseError: null };
    } catch (err) {
      return {
        rows: [],
        parseError: `CSV fallback failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Valid JSON — validate against a permissive top-level schema. Unrecognised
  // shapes are recorded as a parseError but never thrown.
  try {
    const validated = RowsWrapperSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        rows: [],
        parseError:
          `Unrecognised CLWRota JSON shape (expected array, central_api object, or wrapped rows). ` +
          `Details: ${validated.error.errors
            .slice(0, 3)
            .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
            .join("; ")}`,
      };
    }

    if (Array.isArray(validated.data)) {
      // Filter out non-object entries defensively — a malformed payload may
      // contain strings/numbers/null mixed into an otherwise-array shape.
      const rows = (validated.data as unknown[]).filter(
        (r): r is Record<string, unknown> =>
          r !== null && typeof r === "object" && !Array.isArray(r),
      );
      return { rows, parseError: null };
    }

    const obj = validated.data as Record<string, unknown>;

    // Rotamap "central_api" shape: { columns: [{field_name, ui_name}, ...],
    // rows: [[v1, v2, ...], ...] }. Zip into keyed objects so downstream
    // pick() lookups work.
    const cols = obj["columns"];
    const rowsRaw = obj["rows"];
    if (
      Array.isArray(cols) && cols.length > 0 &&
      typeof cols[0] === "object" && cols[0] !== null &&
      "field_name" in (cols[0] as Record<string, unknown>) &&
      Array.isArray(rowsRaw)
    ) {
      const fieldNames = (cols as Array<Record<string, unknown>>).map(
        (c) => String(c.field_name ?? ""),
      );
      if (rowsRaw.length > 0 && !Array.isArray(rowsRaw[0]) && typeof rowsRaw[0] === "object") {
        const rows = (rowsRaw as unknown[]).filter(
          (r): r is Record<string, unknown> =>
            r !== null && typeof r === "object" && !Array.isArray(r),
        );
        return { rows, parseError: null };
      }
      const rows = (rowsRaw as unknown[]).map((r) => {
        const out: Record<string, unknown> = {};
        if (Array.isArray(r)) {
          fieldNames.forEach((name, i) => {
            if (name) out[name] = r[i];
          });
        }
        return out;
      });
      return { rows, parseError: null };
    }

    // Common shapes: { data: [...] }, { rows: [...] }, { results: [...] }, etc.
    for (const key of ["data", "rows", "results", "staff", "people", "persons", "report", "items"]) {
      if (Array.isArray(obj[key])) {
        const rows = (obj[key] as unknown[]).filter(
          (r): r is Record<string, unknown> =>
            r !== null && typeof r === "object" && !Array.isArray(r),
        );
        return { rows, parseError: null };
      }
    }
    // Fallback: first array-valued property anywhere at the top level whose
    // elements are non-array objects (avoids picking `columns` metadata).
    for (const [k, v] of Object.entries(obj)) {
      if (k === "columns") continue;
      if (Array.isArray(v) && v.length && typeof v[0] === "object" && !Array.isArray(v[0])) {
        const rows = (v as unknown[]).filter(
          (r): r is Record<string, unknown> =>
            r !== null && typeof r === "object" && !Array.isArray(r),
        );
        return { rows, parseError: null };
      }
    }
    return {
      rows: [],
      parseError:
        "JSON parsed but no recognisable row container found " +
        "(no top-level array, no central_api columns/rows, no data/rows/results/staff/people/items wrapper)",
    };
  } catch (err) {
    // Last-resort safety net: any unexpected runtime error during shape
    // detection / row zipping is captured rather than propagated.
    return {
      rows: [],
      parseError: `Unexpected error parsing CLWRota payload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}



export function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    // Support dotted paths like "person.email" → row.person.email
    const v = k.includes(".")
      ? k.split(".").reduce<unknown>((acc, part) => {
          if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
          return undefined;
        }, row)
      : row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
  }
  return null;
}

/**
 * Pull staff from the configured CLWRota staff report URL and update existing
 * profiles in-place (matched by email, case-insensitive). New people that
 * aren't already in the app are listed as unmatched — they need to be invited
 * separately to get an auth login before they can be linked.
 */

// ---------------------------------------------------------------------
// Normalisers and duty-type classifiers
// ---------------------------------------------------------------------

export type SessionHalf = "am" | "pm" | "eve" | "night";

export function normaliseSession(raw: string | null): SessionHalf | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "am" || s.includes("morning") || s.startsWith("a.m")) return "am";
  if (s === "pm" || s.includes("afternoon") || s.startsWith("p.m")) return "pm";
  if (s.includes("evening") || s === "eve") return "eve";
  if (s.includes("night")) return "night";
  // ISO timestamp like "2026-05-26T08:00:00+01:00" — extract the hour after T.
  const iso = s.match(/t(\d{2}):(\d{2})/);
  if (iso) {
    const h = parseInt(iso[1], 10);
    if (h < 12) return "am";
    if (h < 17) return "pm";
    if (h < 21) return "eve";
    return "night";
  }
  // Bare time like "08:00" or "13.30".
  const m = s.match(/^(\d{1,2})[:.](\d{2})/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h < 12) return "am";
    if (h < 17) return "pm";
    if (h < 21) return "eve";
    return "night";
  }
  return null;
}

/**
 * Return the AM/PM half-day session(s) that a CLWRota shift covers, given
 * its raw start_time / end_time strings. Used to correctly split single
 * "all-day" CLWRota rows (e.g. a Medical Examiner session running
 * 08:00–17:00) into both an AM and a PM assignment so every rota view
 * shows the person in both halves.
 *
 * Boundary rule: AM = [00:00, 13:00), PM = [13:00, 24:00). A shift that
 * ends exactly at 13:00 stays AM-only; a shift that starts exactly at
 * 13:00 is PM-only.
 *
 * Returns an empty array when the range cannot be parsed — callers should
 * fall back to `normaliseSession()` on the raw session/shift label.
 */
export function sessionsCoveredByTimeRange(
  startRaw: string | null | undefined,
  endRaw: string | null | undefined,
): Array<"am" | "pm"> {
  const startH = extractHour(startRaw);
  const endH = extractHour(endRaw);
  if (startH === null || endH === null) return [];
  // End before start (e.g. crosses midnight) — treat as unknown and let the
  // caller fall back to the shift label.
  if (endH <= startH) return [];
  const halves: Array<"am" | "pm"> = [];
  if (startH < 13) halves.push("am");
  if (endH > 13) halves.push("pm");
  return halves;
}

function extractHour(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const iso = s.match(/t(\d{2}):(\d{2})/);
  if (iso) {
    const h = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    if (Number.isFinite(h)) return h + (Number.isFinite(m) ? m / 60 : 0);
  }
  const bare = s.match(/^(\d{1,2})[:.](\d{2})/);
  if (bare) {
    const h = parseInt(bare[1], 10);
    const m = parseInt(bare[2], 10);
    if (Number.isFinite(h)) return h + (Number.isFinite(m) ? m / 60 : 0);
  }
  return null;
}

export function normaliseDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

export function normaliseRole(
  raw: string | null,
): "solo" | "supervised" | "supervising" | "on_call" | "non_clinical" | "teaching" | "admin_session" {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.includes("trainer") || (s.includes("supervis") && (s.includes("ing") || s.includes("or"))))
    return "supervising";
  if (s.includes("supervised") || s.includes("trainee")) return "supervised";
  if (s.includes("on call") || s.includes("on-call") || s.includes("oncall")) return "on_call";
  if (s.includes("teach")) return "teaching";
  if (s.includes("admin")) return "admin_session";
  if (s.includes("non") && s.includes("clin")) return "non_clinical";
  return "solo";
}

export type ResolvedDutyType =
  | "theatre"
  | "consultant_in_charge"
  | "obstetrics"
  | "obstetrics_2nd"
  | "icu_trainee"
  | "icu_ct2_plus"
  | "icu_consultant_oncall"
  | "general_consultant_oncall"
  | "registrar_oncall"
  | "sho_oncall"
  | "spa"
  | "admin"
  | "teaching"
  | "non_clinical"
  | "medical_examiner";

export const NON_PATIENT_FACING_DUTY_TYPES: ReadonlySet<ResolvedDutyType> = new Set([
  "spa",
  "admin",
  "teaching",
  "non_clinical",
  "medical_examiner",
]);

/**
 * Heuristic detector for CLWRota rows that a human would recognise as a
 * Medical Examiner session but whose configured duty_type_mappings didn't
 * classify to `medical_examiner`. Used by the sync validation step to
 * surface unmapped ME sessions in the admin alert so admins can add a
 * missing mapping row instead of silently mis-classifying the session.
 *
 * Matches the same phrases the seed mappings use ("medical examiner",
 * "medical examiners", "ME session") across any free-text field on the
 * row, case-insensitively and tolerant of surrounding punctuation.
 */
export function looksLikeMedicalExaminerLabel(
  labels: ReadonlyArray<string | null | undefined>,
): boolean {
  for (const raw of labels) {
    if (!raw) continue;
    const s = String(raw).toLowerCase();
    if (s.includes("medical examiner")) return true;
    // "ME session", "ME sessions", "M.E. session" — require a word boundary
    // on the ME so we don't false-positive on "me" inside other words.
    if (/(^|[^a-z])m\.?e\.?\s+sessions?\b/i.test(raw)) return true;
  }
  return false;
}

/**
 * Heuristic detector for CLWRota rows that describe a tutorial / lecture /
 * departmental teaching session delivered by a member of staff (typically
 * a consultant or SAS doctor). Used by the sync to stamp a "Tutorial: …"
 * prefix on the assignment notes so downstream views (the Tutorials audit
 * and the "Tutorials" row on the global calendar) can identify them
 * reliably without re-parsing the CLWRota free text.
 *
 * Deliberately conservative — matches whole-word tutorial/tutor/lecture
 * tokens and the phrase "departmental teaching" only, so plain trainee
 * teaching blocks ("Non-patient-facing: Fellow") do not get mislabelled.
 */
export function looksLikeTutorialLabel(
  labels: ReadonlyArray<string | null | undefined>,
): boolean {
  for (const raw of labels) {
    if (!raw) continue;
    const s = String(raw).toLowerCase();
    if (/\btutorials?\b/.test(s)) return true;
    if (/\btutor\b/.test(s) && !/college\s+tutor/.test(s)) return true;
    if (/\blectures?\b/.test(s)) return true;
    if (/departmental\s+teaching/.test(s)) return true;
    if (/\bimt\s+teaching\b/.test(s)) return true;
    if (/\bteaching\s*\/\s*outpatients?\b/.test(s)) return true;
  }
  return false;
}

export type DutyTypeMappingRow = {
  duty_type: ResolvedDutyType;
  pattern: string;
  match_type: "substring" | "word" | "regex";
  grade_filter: "consultant" | "sas" | "trainee" | null;
  trainee_seniority_filter: "junior" | "senior" | null;
  priority: number;
  active: boolean;
};

function isJuniorTraineeLevel(trainingLevel: string | null | undefined): boolean {
  const tl = (trainingLevel ?? "").toUpperCase();
  return tl === "CT1" || tl === "CT2" || tl === "ACCS1" || tl === "ACCS2" || tl === "ACCS3";
}

/**
 * Normalise free-text labels and patterns so the classifier is robust to
 * casing, surrounding whitespace, internal whitespace runs (e.g. "ON  CALL"),
 * and common separators that humans use interchangeably with spaces — hyphens,
 * underscores, slashes (e.g. "on-call", "on_call", "on/call"). NB: regex
 * patterns are NOT normalised — authors of `match_type: "regex"` rules are
 * expected to handle their own whitespace/hyphen variants explicitly.
 */
export function normaliseClassifierText(raw: string): string {
  return normaliseRotaLabelText(raw);
}

function mappingMatches(
  mapping: DutyTypeMappingRow,
  text: string,
  grade: string | null | undefined,
  trainingLevel: string | null | undefined,
): boolean {
  if (mapping.grade_filter && grade !== mapping.grade_filter) return false;
  if (mapping.trainee_seniority_filter) {
    if (grade !== "trainee") return false;
    const junior = isJuniorTraineeLevel(trainingLevel);
    if (mapping.trainee_seniority_filter === "junior" && !junior) return false;
    if (mapping.trainee_seniority_filter === "senior" && junior) return false;
  }
  switch (mapping.match_type) {
    case "substring": {
      const p = normaliseClassifierText(mapping.pattern);
      return text.includes(p);
    }
    case "word": {
      const p = normaliseClassifierText(mapping.pattern);
      return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
    }
    case "regex":
      try {
        return new RegExp(mapping.pattern, "i").test(text);
      } catch {
        return false;
      }
  }
}

/**
 * Classify a CLWRota row as a non-theatre duty using admin-configured
 * mappings (priority asc). Falls back to "theatre" when nothing matches.
 *
 * Input labels are normalised (lowercased, hyphens/underscores/slashes
 * collapsed to spaces, whitespace runs collapsed) before matching so that
 * "ON  CALL", "On-Call", and "on call" all behave identically.
 */
export function classifyDutyType(
  labels: Array<string | null | undefined>,
  grade: string | null | undefined,
  trainingLevel: string | null | undefined,
  mappings: DutyTypeMappingRow[],
): ResolvedDutyType {
  const joined = labels.filter(Boolean).join(" ");
  const text = normaliseClassifierText(joined);
  if (!text) return "theatre";
  for (const m of mappings) {
    if (!m.active) continue;
    if (mappingMatches(m, text, grade, trainingLevel)) return m.duty_type;
  }
  return "theatre";
}

/**
 * Resolve an off-site / specialty-room theatre from free-text label(s) when
 * the exact-name lookup misses. CLWRota labels these locations
 * inconsistently across the rota (e.g. "Endoscopy" vs "Endo GA" vs
 * "Endoscopy GA", "Laser (Paeds)" vs "Laser", "NHH Theatre 3" vs "NHH T3"
 * vs "NHH 3" vs bare "NHH"), so we keyword-match against a small set of
 * known off-site theatres.
 *
 * Returns the matched theatre id (from the provided lower-cased name map)
 * or undefined when nothing reasonable matches. The caller is expected to
 * have already tried an exact lookup.
 */
export function resolveOffsiteTheatreAlias(
  text: string | null | undefined,
  theatreByName: Map<string, string>,
): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (!t.trim()) return undefined;

  // NHH (New Hall Hospital) — optionally with a numbered theatre.
  // Accepts "nhh theatre 3", "nhh t3", "nhh 3", or bare "nhh" / "new hall".
  // Excludes "nhh 1st oncall" which is classified as a duty, not a theatre.
  if (/\b(nhh|new\s*hall)\b/.test(t) && !/on.?call/.test(t)) {
    const numMatch = t.match(/\b(?:nhh|new\s*hall)\s*(?:theatre\s*|t)?(\d)\b/);
    const n = numMatch ? numMatch[1] : "1";
    return (
      theatreByName.get(`nhh theatre ${n}`) ??
      theatreByName.get("nhh theatre 1") ??
      theatreByName.get("nhh")
    );
  }

  // Order matters: more specific keywords first.
  const aliases: Array<{ test: RegExp; names: string[] }> = [
    // Acute Pain Service is a real procedural pain list location, but the
    // configured theatre is named simply "Pain".
    { test: /\bacute\s+pain\s+(service|list)?\b|\bpain\s+service\b/, names: ["pain"] },
    // Endoscopy room — "Endoscopy", "Endo GA", "Endo".
    { test: /\bendo(scopy)?\b/, names: ["endo", "endoscopy"] },
    // MRI suite (anaesthetic cover for scans).
    { test: /\bmri\b/, names: ["mri"] },
    // Cardioversions — only the procedure list, not generic "cardiac" surgery.
    { test: /\bcardiover(sion)?s?\b/, names: ["cardioversions", "cardioversion"] },
    // Laser room — "Laser", "Laser (Paeds)".
    { test: /\blaser\b/, names: ["laser"] },
  ];
  for (const a of aliases) {
    if (!a.test.test(t)) continue;
    for (const n of a.names) {
      const id = theatreByName.get(n);
      if (id) return id;
    }
  }
  return undefined;
}

