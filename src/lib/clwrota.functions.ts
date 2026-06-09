import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isNonWorkingRotaLabel, normaliseRotaLabelText } from "./clwrota-labels";
import { evaluateHistoricalSafeguard } from "./clwrota-historical-safeguard";
import {
  parseListClwRotaSyncMetricsResponse,
  type ListClwRotaSyncMetricsResponse,
} from "./clwrota-metrics-types";

/**
 * CLWRota (Rotamap Central API) integration — pull-only.
 *
 * The CLWRota Central API works with per-report signed URLs that an admin
 * generates inside CLWRota. The API key is sent as a bearer token. Each
 * report URL returns JSON or CSV for that specific report (rota, leave,
 * staff list, etc.).
 *
 * Admins paste the report URLs into Settings → CLWRota. The sync function
 * fetches each configured URL and stores a summary in `clwrota_sync_state`.
 *
 * Mapping pulled rows to local `rota_assignments`/`leave_requests`/`profiles`
 * is deliberately left as TODO until we see a real sample payload — the
 * exact field names vary per CLWRota deployment.
 */

function getEnv() {
  const apiKey = process.env.CLWROTA_API_KEY;
  const baseUrl = process.env.CLWROTA_BASE_URL;
  if (!apiKey) throw new Error("CLWROTA_API_KEY is not configured");
  if (!baseUrl) throw new Error("CLWROTA_BASE_URL is not configured");
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

/** Verify the API key + base URL work by hitting a real Central API endpoint. */
export const testClwRotaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { apiKey, baseUrl } = getEnv();

    // Hit a real Central API endpoint — the bare base URL returns the login
    // HTML page even without auth, which would be a false positive.
    const probeUrl = `${baseUrl}/central_api/query/services?fields=id_name`;
    const started = Date.now();
    try {
      const res = await fetch(probeUrl, {
        method: "GET",
        headers: {
          "X-Auth": apiKey,
          Accept: "application/json",
        },
      });
      const elapsed = Date.now() - started;
      const bodyPreview = (await res.text()).slice(0, 500);
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        elapsedMs: elapsed,
        bodyPreview,
        baseUrl: probeUrl,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        statusText: err instanceof Error ? err.message : "Network error",
        elapsedMs: Date.now() - started,
        bodyPreview: "",
        baseUrl: probeUrl,
      };
    }
  });

/** Load the current sync state row (settings + last run). */
export const getClwRotaSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      settings: data ?? null,
      hasApiKey: Boolean(process.env.CLWROTA_API_KEY),
      hasBaseUrl: Boolean(process.env.CLWROTA_BASE_URL),
      baseUrl: process.env.CLWROTA_BASE_URL ?? null,
    };
  });

const urlOrNull = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().url().max(2000).nullable(),
);
const SettingsSchema = z.object({
  rota_report_url: urlOrNull,
  leave_report_url: urlOrNull,
  staff_report_url: urlOrNull,
  sync_days_back: z.coerce.number().int().min(0).max(3650).default(30),
  sync_days_ahead: z.coerce.number().int().min(1).max(3650).default(120),
  auto_reclassify_trainee_solo: z.coerce.boolean().default(false),
});

export const saveClwRotaSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SettingsSchema.parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("clwrota_sync_state")
      .upsert({ id: 1, ...data });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * List recent auto-reclassification sync runs (most recent first) with the
 * number of rows changed. Used by the admin UI to offer per-run undo.
 */
export const listReclassificationRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("rota_reclassification_log")
      .select("sync_run_id, created_at, from_role, to_role")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    const byRun = new Map<
      string,
      { sync_run_id: string; created_at: string; count: number; from_role: string; to_role: string }
    >();
    for (const r of data ?? []) {
      const existing = byRun.get(r.sync_run_id);
      if (existing) {
        existing.count += 1;
        if (r.created_at > existing.created_at) existing.created_at = r.created_at;
      } else {
        byRun.set(r.sync_run_id, {
          sync_run_id: r.sync_run_id,
          created_at: r.created_at,
          count: 1,
          from_role: r.from_role,
          to_role: r.to_role,
        });
      }
    }
    return {
      runs: Array.from(byRun.values()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    };
  });

/**
 * Undo a single auto-reclassification sync run: for every logged change in
 * the run, revert the assignment back to its previous role — but only when
 * the current role still equals what the auto-reclassify set it to, so we
 * never clobber a subsequent manual change. Log entries are deleted on
 * success so the run no longer appears as undoable.
 */
export const undoReclassificationRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ sync_run_id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { data: entries, error: loadErr } = await supabaseAdmin
      .from("rota_reclassification_log")
      .select("id, assignment_id, from_role, to_role")
      .eq("sync_run_id", data.sync_run_id);
    if (loadErr) throw new Error(loadErr.message);
    if (!entries || entries.length === 0) {
      return { ok: true, reverted: 0, skipped: 0, deletedLogRows: 0 };
    }

    let reverted = 0;
    let skipped = 0;
    const revertedLogIds: string[] = [];
    for (const e of entries) {
      const { data: upd, error: updErr } = await supabaseAdmin
        .from("rota_assignments")
        .update({ role_on_list: e.from_role })
        .eq("id", e.assignment_id)
        .eq("role_on_list", e.to_role)
        .select("id");
      if (updErr) throw new Error(updErr.message);
      if (upd && upd.length > 0) {
        reverted += 1;
        revertedLogIds.push(e.id);
      } else {
        skipped += 1;
      }
    }

    let deletedLogRows = 0;
    if (revertedLogIds.length > 0) {
      const DEL_CHUNK = 200;
      for (let i = 0; i < revertedLogIds.length; i += DEL_CHUNK) {
        const idChunk = revertedLogIds.slice(i, i + DEL_CHUNK);
        const { error: delErr } = await supabaseAdmin
          .from("rota_reclassification_log")
          .delete()
          .in("id", idChunk);
        if (delErr) throw new Error(delErr.message);
        deletedLogRows += idChunk.length;
      }
    }
    return { ok: true, reverted, skipped, deletedLogRows };
  });

/**
 * On-demand investigation: re-evaluate every trainee `solo` rota_assignment
 * in a date window and (optionally) apply corrections for the case where a
 * consultant or SAS doctor is assigned to the same theatre_session.
 *
 * Always returns counts for the two review-only categories
 * (unmatched_theatre_solo, non_training_label) so a coordinator can act on
 * them manually. Locally-modified rows are never touched.
 */
export const investigateAndFixTraineeSolo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        apply: z.boolean().default(false),
        days_back: z.coerce.number().int().min(0).max(3650).default(60),
        days_ahead: z.coerce.number().int().min(0).max(3650).default(60),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { computeSoloCorrections } = await import("./solo-investigate");

    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - data.days_back);
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + data.days_ahead);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const startStr = fmt(start);
    const endStr = fmt(end);

    // Pull every rota_assignment in the window with the staff grade joined.
    const { data: rows, error: rowsErr } = await supabaseAdmin
      .from("rota_assignments")
      .select(
        "id,staff_id,role_on_list,theatre_session_id,session_date,duty_type,session,locally_modified,profiles!rota_assignments_staff_id_fkey(id,grade,full_name)",
      )
      .gte("session_date", startStr)
      .lte("session_date", endStr);
    if (rowsErr) throw new Error(rowsErr.message);

    type RA = {
      id: string;
      staff_id: string;
      role_on_list: string;
      theatre_session_id: string | null;
      session_date: string | null;
      duty_type: string | null;
      session: string | null;
      locally_modified: boolean | null;
      profiles: { id: string; grade: string | null; full_name: string | null } | null;
    };
    const allRows = ((rows ?? []) as unknown as RA[]).filter((r) => r.profiles);

    // Build profiles map (every staff_id on any row in the window).
    const profilesById = new Map<
      string,
      { id: string; grade: string | null; full_name?: string | null }
    >();
    for (const r of allRows) {
      if (r.profiles) profilesById.set(r.profiles.id, r.profiles);
    }

    // Load theatre sessions touched by these rows so we can detect
    // non-working labels.
    const tsIds = Array.from(
      new Set(allRows.map((r) => r.theatre_session_id).filter((v): v is string => !!v)),
    );
    const theatreSessionsById = new Map<
      string,
      { id: string; specialty_name?: string | null; surgical_consultant?: string | null; notes?: string | null }
    >();
    if (tsIds.length > 0) {
      const TS_CHUNK = 500;
      for (let i = 0; i < tsIds.length; i += TS_CHUNK) {
        const chunk = tsIds.slice(i, i + TS_CHUNK);
        const { data: tsRows, error: tsErr } = await supabaseAdmin
          .from("theatre_sessions")
          .select("id,surgical_consultant,notes,specialties(name)")
          .in("id", chunk);
        if (tsErr) throw new Error(tsErr.message);
        for (const r of (tsRows ?? []) as unknown as Array<{
          id: string;
          surgical_consultant: string | null;
          notes: string | null;
          specialties: { name: string | null } | null;
        }>) {
          theatreSessionsById.set(r.id, {
            id: r.id,
            specialty_name: r.specialties?.name ?? null,
            surgical_consultant: r.surgical_consultant,
            notes: r.notes,
          });
        }
      }
    }

    // Custom non-working tokens configured by coordinators.
    const { data: tokenRows } = await supabaseAdmin
      .from("validation_custom_non_working_labels")
      .select("token");
    const extraTokens = (tokenRows ?? []).map((r) => r.token).filter(Boolean);

    const corrections = computeSoloCorrections({
      assignments: allRows.map((r) => ({
        id: r.id,
        staff_id: r.staff_id,
        role_on_list: r.role_on_list,
        theatre_session_id: r.theatre_session_id,
        session_date: r.session_date,
        duty_type: r.duty_type,
        session: r.session,
        locally_modified: r.locally_modified,
      })),
      profilesById,
      theatreSessionsById,
      extraNonWorkingTokens: extraTokens,
    });

    const byCategory = {
      consultant_or_sas_on_session: corrections.filter(
        (c) => c.category === "consultant_or_sas_on_session",
      ),
      unmatched_theatre_solo: corrections.filter(
        (c) => c.category === "unmatched_theatre_solo",
      ),
      non_training_label: corrections.filter((c) => c.category === "non_training_label"),
    };

    let applied = 0;
    let sync_run_id: string | null = null;
    if (data.apply && byCategory.consultant_or_sas_on_session.length > 0) {
      sync_run_id = crypto.randomUUID();
      // Group by proposed supervisor for chunked update.
      const groups = new Map<string, typeof byCategory.consultant_or_sas_on_session>();
      for (const c of byCategory.consultant_or_sas_on_session) {
        const key = c.proposed_supervisor_id ?? "__none__";
        const list = groups.get(key) ?? [];
        list.push(c);
        groups.set(key, list);
      }
      for (const [sup, items] of groups) {
        const ids = items.map((c) => c.assignment_id);
        const CHUNK = 200;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const idChunk = ids.slice(i, i + CHUNK);
          const update: { role_on_list: "supervised"; supervisor_id?: string } = {
            role_on_list: "supervised",
          };
          if (sup !== "__none__") update.supervisor_id = sup;
          const { error: updErr } = await supabaseAdmin
            .from("rota_assignments")
            .update(update)
            .in("id", idChunk);
          if (updErr) throw new Error(updErr.message);
          const { error: logErr } = await supabaseAdmin
            .from("rota_reclassification_log")
            .insert(
              idChunk.map((id) => ({
                sync_run_id: sync_run_id!,
                assignment_id: id,
                from_role: "solo" as const,
                to_role: "supervised" as const,
                reason:
                  sup !== "__none__"
                    ? "manual investigation: consultant/SAS on same session (supervisor set)"
                    : "manual investigation: consultant/SAS on same session",
              })),
            );
          if (logErr) throw new Error(logErr.message);
          applied += idChunk.length;
        }
      }
    }

    return {
      ok: true,
      window: { start: startStr, end: endStr },
      counts: {
        consultant_or_sas_on_session: byCategory.consultant_or_sas_on_session.length,
        unmatched_theatre_solo: byCategory.unmatched_theatre_solo.length,
        non_training_label: byCategory.non_training_label.length,
      },
      applied,
      sync_run_id,
      sample: corrections.slice(0, 25),
    };
  });





/**
 * Rewrite the CLWRota report URL so the date window always extends at least
 * 12 months past today. CLWRota report URLs are generated with a fixed
 * `start_date` / `end_date` window — without this, scheduled syncs would
 * silently stop returning future rows as time passes.
 *
 * - `end_date` is pushed forward to max(existing, today + 12 months).
 * - `start_date` is preserved so historical context isn't lost; if it would
 *   end up after `end_date` (shouldn't happen) it's clamped to today.
 */
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

async function fetchReportRaw(
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
const RotamapCentralApiSchema = z.object({
  columns: z.array(z.object({ field_name: z.unknown() }).passthrough()).min(1),
  rows: z.array(z.unknown()),
}).passthrough();

const RowsWrapperSchema = z.union([
  z.array(z.record(z.unknown())),
  RotamapCentralApiSchema,
  z.record(z.unknown()), // generic wrapper — we'll probe known keys below
]);

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
function parseRows(text: string): { rows: Record<string, unknown>[]; parseError: string | null } {
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



function pick(row: Record<string, unknown>, keys: string[]): string | null {
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
export const syncClwRotaStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    return performStaffSync();
  });

export async function performStaffSync() {
    const startedAt = Date.now();
    const { apiKey } = getEnv();

    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("staff_report_url")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);

    const url = settings?.staff_report_url;
    const emptyDiagnostics = {
      rowsWithEmail: 0,
      rowsBlankEmail: 0,
      rowsInvalidEmail: 0,
      rowsDuplicateEmail: 0,
      emailFieldsTried: ["email", "email_address", "Email", "e_mail", "EmailAddress"],
      detectedEmailFields: [] as string[],
    };
    if (!url) {
      return {
        ok: false,
        message: "No staff report URL configured.",
        total: 0,
        matched: 0,
        updated: 0,
        insertedCount: 0,
        insertedList: [] as Array<{ name: string; email: string }>,
        unchangedCount: 0,
        skipped: [] as Array<{ label: string; reason: string }>,
        errors: [] as Array<{ label: string; error: string }>,
        rawPreview: "",
        sampleKeys: [] as string[],
        emailDiagnostics: emptyDiagnostics,
      };
    }

    let rows: Record<string, unknown>[];
    let rawPreview = "";
    let sampleKeys: string[] = [];
    let parseError: string | null = null;
    try {
      const text = await fetchReportRaw(url, apiKey);
      rawPreview = text.slice(0, 500);
      const parsed = parseRows(text);
      rows = parsed.rows;
      parseError = parsed.parseError;
      if (rows.length > 0) sampleKeys = Object.keys(rows[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabaseAdmin.from("clwrota_sync_state").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: "staff_fetch_failed",
        last_error: msg,
      });
      throw new Error(msg);
    }

    if (rows.length === 0) {
      const reason = parseError
        ? `Staff URL returned no recognisable rows. ${parseError}. Response preview: ${rawPreview.slice(0, 200)}`
        : `Staff URL returned no recognisable rows. Response preview: ${rawPreview.slice(0, 200)}`;
      await supabaseAdmin.from("clwrota_sync_state").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: "staff_no_rows",
        last_error: reason,
        last_pulled_rows: 0,
      });

      return {
        ok: false,
        message: "Staff URL returned 0 rows. See preview below.",
        total: 0,
        matched: 0,
        updated: 0,
        insertedCount: 0,
        insertedList: [] as Array<{ name: string; email: string }>,
        unchangedCount: 0,
        skipped: [] as Array<{ label: string; reason: string }>,
        errors: [] as Array<{ label: string; error: string }>,
        rawPreview,
        sampleKeys,
        emailDiagnostics: emptyDiagnostics,
      };
    }

    // Load existing profiles once, indexed by lower-cased email AND by
    // CLWRota external id so we can fall back when the email in CLWRota has
    // changed (otherwise the insert path trips profiles_clwrota_external_id_key).
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("id, email, clwrota_external_id");
    if (profErr) throw new Error(profErr.message);
    const byEmail = new Map<string, string>();
    const byExtId = new Map<string, { id: string; email: string | null }>();
    for (const p of profiles ?? []) {
      if (p.email) byEmail.set(p.email.toLowerCase(), p.id);
      if (p.clwrota_external_id)
        byExtId.set(String(p.clwrota_external_id), { id: p.id, email: p.email ?? null });
    }


    let matched = 0;
    let updated = 0;
    let unchangedCount = 0;
    const insertedList: Array<{ name: string; email: string }> = [];
    const skipped: Array<{ label: string; reason: string }> = [];
    const errors: Array<{ label: string; error: string }> = [];

    // Email diagnostics
    const emailFieldsTried = [
      "email",
      "email_address",
      "Email",
      "e_mail",
      "EmailAddress",
    ];
    const detectedEmailFields = new Set<string>();
    let rowsWithEmail = 0;
    let rowsBlankEmail = 0;
    let rowsInvalidEmail = 0;
    let rowsDuplicateEmail = 0;
    const seenEmailsThisRun = new Set<string>();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Pick raw email value (preserving whether the field exists vs is blank)
    function pickRawEmail(row: Record<string, unknown>): {
      field: string | null;
      value: string;
    } {
      for (const k of emailFieldsTried) {
        if (k in row) {
          const v = row[k];
          if (typeof v === "string") return { field: k, value: v };
          if (typeof v === "number") return { field: k, value: String(v) };
          if (v == null) return { field: k, value: "" };
        }
      }
      return { field: null, value: "" };
    }

    for (const row of rows) {
      const first =
        pick(row, ["first_name", "firstname", "given_name", "forename", "First Name"]) ?? "";
      const last =
        pick(row, ["last_name", "lastname", "surname", "family_name", "Last Name"]) ?? "";
      const composed = `${first} ${last}`.trim();
      const fullName =
        pick(row, [
          "rota_name",
          "person.rota_name",
          "display_name",
          "full_name",
          "fullname",
          "name",
          "person_name",
          "Name",
          "person.name",
        ]) ??
        composed ??
        "";
      const externalId = pick(row, [
        "local_id",
        "id",
        "person_id",
        "external_id",
        "Local ID",
      ]);
      const gmc = pick(row, ["gmc_number", "gmc", "GMC", "gmc_no"]);
      const startDate = pick(row, ["start_date", "employment_start", "Start Date"]);
      const endDate = pick(row, ["end_date", "employment_end", "End Date"]);

      // Grade / role / training-level extraction. Rotamap exposes role text
      // under various keys; keep the raw text as training_level and bucket it
      // into our `grade` enum (consultant | sas | trainee).
      const roleRaw =
        pick(row, [
          "role.name",
          "role_category.name",
          "grade",
          "Grade",
          "role",
          "Role",
          "job_title",
          "jobtitle",
          "JobTitle",
          "title",
          "Title",
          "position",
          "Position",
          "post",
          "Post",
          "rota_role",
          "person.grade",
          "person.role",
          "person.job_title",
          "person.title",
          "person.post",
        ]) ?? "";
      const categoryCode = (pick(row, ["role_category.code"]) ?? "").toUpperCase();
      const roleLower = roleRaw.toLowerCase();
      let derivedGrade: "consultant" | "sas" | "trainee" | null = null;
      // Prefer the explicit Rotamap role_category code when present.
      if (categoryCode === "CONS") derivedGrade = "consultant";
      else if (categoryCode === "SASS") derivedGrade = "sas";
      else if (categoryCode === "JTRN" || categoryCode === "STRN") derivedGrade = "trainee";
      else if (roleLower) {
        if (/consultant|attending/.test(roleLower)) derivedGrade = "consultant";
        else if (
          /\b(sas|specialty\s*doctor|speciality\s*doctor|specialist\s*doctor|associate\s*specialist|staff\s*grade)\b/.test(
            roleLower,
          )
        )
          derivedGrade = "sas";
        else if (
          /trainee|registrar|resident|fellow|\bst\d+\b|\bct\d+\b|\bspr\b|\bsho\b|\bfy?\d\b|core|foundation|accs/.test(
            roleLower,
          )
        )
          derivedGrade = "trainee";
      }


      const { field: emailField, value: emailRaw } = pickRawEmail(row);
      if (emailField) detectedEmailFields.add(emailField);
      const emailTrimmed = emailRaw.trim();
      const emailLower = emailTrimmed.toLowerCase();

      // Build a rich label so missing-email rows can still be identified.
      const identifiers: string[] = [];
      if (fullName) identifiers.push(fullName);
      if (externalId) identifiers.push(`id=${externalId}`);
      if (gmc) identifiers.push(`GMC=${gmc}`);
      const label =
        identifiers.length > 0
          ? identifiers.join(" · ")
          : `(row keys: ${Object.keys(row).slice(0, 6).join(", ")})`;

      if (!emailTrimmed) {
        rowsBlankEmail++;
        const reason =
          emailField == null
            ? `no email field found (tried: ${emailFieldsTried.join(", ")})`
            : `email field "${emailField}" is blank`;
        skipped.push({ label, reason });
        continue;
      }

      if (!emailRegex.test(emailTrimmed)) {
        rowsInvalidEmail++;
        skipped.push({
          label,
          reason: `invalid email format: "${emailTrimmed}" (from field "${emailField}")`,
        });
        continue;
      }

      rowsWithEmail++;

      if (seenEmailsThisRun.has(emailLower)) {
        rowsDuplicateEmail++;
        skipped.push({
          label,
          reason: `duplicate email in CLWRota feed: ${emailTrimmed}`,
        });
        continue;
      }
      seenEmailsThisRun.add(emailLower);

      const isEndedPast =
        endDate != null &&
        !Number.isNaN(Date.parse(endDate)) &&
        Date.parse(endDate) < Date.now();

      let profileId = byEmail.get(emailLower);

      // Fall back to clwrota_external_id when the email in CLWRota has changed
      // for an already-known staff member. Without this we'd try to INSERT a
      // new profile carrying the same external id and hit the unique constraint
      // profiles_clwrota_external_id_key.
      if (!profileId && externalId) {
        const byExt = byExtId.get(externalId);
        if (byExt) {
          profileId = byExt.id;
          // Refresh maps so a later row in this run sees the new linkage.
          byEmail.set(emailLower, byExt.id);
          if (byExt.email) byEmail.delete(byExt.email.toLowerCase());
          byExtId.set(externalId, { id: byExt.id, email: emailTrimmed });
        }
      }

      if (!profileId) {
        const newRow: {
          id: string;
          email: string;
          full_name: string;
          clwrota_external_id?: string;
          gmc_number?: string;
          start_date?: string;
          grade?: "consultant" | "sas" | "trainee";
          training_level?: string;
          active: boolean;
        } = {
          id: crypto.randomUUID(),
          email: emailTrimmed,
          full_name: fullName || emailTrimmed,
          active: !isEndedPast,
        };
        if (externalId) newRow.clwrota_external_id = externalId;
        if (gmc) newRow.gmc_number = gmc;
        if (startDate) newRow.start_date = startDate;
        if (derivedGrade) newRow.grade = derivedGrade;
        if (roleRaw) newRow.training_level = roleRaw;

        const { data: insData, error: insErr } = await supabaseAdmin
          .from("profiles")
          .insert(newRow)
          .select("id")
          .single();
        if (insErr) {
          errors.push({
            label: `${label} <${emailTrimmed}>`,
            error: `insert: ${insErr.message}`,
          });
        } else {
          insertedList.push({ name: fullName || emailTrimmed, email: emailTrimmed });
          if (insData?.id) {
            byEmail.set(emailLower, insData.id);
            if (externalId) byExtId.set(externalId, { id: insData.id, email: emailTrimmed });
          }
        }
        continue;
      }


      matched++;
      const patch: {
        full_name?: string;
        email?: string;
        clwrota_external_id?: string;
        gmc_number?: string;
        start_date?: string;
        grade?: "consultant" | "sas" | "trainee";
        training_level?: string;
        active?: boolean;
      } = {};
      if (fullName) patch.full_name = fullName;
      if (externalId) patch.clwrota_external_id = externalId;
      // If we matched this row via external id, the email in CLWRota differs
      // from the stored one — propagate the new email.
      if (externalId) {
        const tracked = byExtId.get(externalId);
        if (tracked && tracked.id === profileId && (tracked.email ?? "").toLowerCase() !== emailLower) {
          patch.email = emailTrimmed;
        }
      }
      if (gmc) patch.gmc_number = gmc;
      if (startDate) patch.start_date = startDate;
      if (derivedGrade) patch.grade = derivedGrade;
      if (roleRaw) patch.training_level = roleRaw;
      if (isEndedPast) patch.active = false;

      if (Object.keys(patch).length === 0) {
        unchangedCount++;
        continue;
      }

      const { error: upErr } = await supabaseAdmin
        .from("profiles")
        .update(patch)
        .eq("id", profileId);
      if (upErr) {
        errors.push({
          label: `${label} <${emailTrimmed}>`,
          error: `update: ${upErr.message}`,
        });
      } else {
        updated++;
      }
    }

    const emailDiagnostics = {
      rowsWithEmail,
      rowsBlankEmail,
      rowsInvalidEmail,
      rowsDuplicateEmail,
      emailFieldsTried,
      detectedEmailFields: Array.from(detectedEmailFields),
    };

    const inserted = insertedList.length;
    const summary = `Staff sync: ${rows.length} rows · ${inserted} added · ${updated} updated · ${unchangedCount} unchanged · ${skipped.length} skipped · ${errors.length} errors`;
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: errors.length ? "staff_partial" : "staff_success",
      last_error: errors.length
        ? errors.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join("; ")
        : null,
      last_pulled_rows: rows.length,
    });

    const staffDurationMs = Date.now() - startedAt;
    console.info(
      "[clwrota.metrics]",
      JSON.stringify({
        kind: "staff_sync",
        at: new Date().toISOString(),
        ok: errors.length === 0,
        rows_pulled: rows.length,
        rows_upserted: inserted + updated,
        rows_skipped_validation: skipped.length,
        rows_failed: errors.length,
        errors_count: errors.length,
        duration_ms: staffDurationMs,
      }),
    );
    const { error: staffMetricsErr } = await supabaseAdmin
      .from("clwrota_sync_metrics")
      .insert({
        sync_kind: "staff",
        run_at: new Date().toISOString(),
        ok: errors.length === 0,
        duration_ms: staffDurationMs,
        rows_pulled: rows.length,
        rows_upserted: inserted + updated,
        rows_skipped_validation: skipped.length,
        rows_failed: errors.length,
        errors_count: errors.length,
        notes: errors.length
          ? errors.slice(0, 3).map((e) => `${e.label}: ${e.error}`).join("; ").slice(0, 1000)
          : null,
      });
    if (staffMetricsErr) {
      console.warn("[clwrota] failed to insert staff sync metrics:", staffMetricsErr.message);
    }

    return {
      ok: errors.length === 0,
      message: summary,
      total: rows.length,
      matched,
      updated,
      insertedCount: inserted,
      insertedList,
      unchangedCount,
      skipped,
      errors,
      rawPreview,
      sampleKeys,
      emailDiagnostics,
    };
}





async function fetchReport(url: string, apiKey: string) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Auth": apiKey,
      Accept: "application/json, text/csv;q=0.9",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CLWRota report failed: ${res.status} ${text.slice(0, 200)}`);
  }
  // Count rows using the shared parser so the dashboard reflects ingestable
  // rows (handles Rotamap's {columns, rows} shape).
  let rows = 0;
  try {
    rows = parseRows(text).rows.length;
  } catch {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    rows = Math.max(0, lines.length - 1);
  }

  return { rows, bytes: text.length };
}

/**
 * Pull-only sync. Reads configured report URLs, fetches each, and records
 * counts in `clwrota_sync_state`. Importing the rows into local tables is
 * intentionally deferred until we have a sample payload to map fields.
 */
export const runClwRotaSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { apiKey } = getEnv();

    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("rota_report_url, leave_report_url, staff_report_url")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);

    const urls = [
      ["rota", settings?.rota_report_url],
      ["leave", settings?.leave_report_url],
      ["staff", settings?.staff_report_url],
    ].filter(([, u]) => Boolean(u)) as Array<[string, string]>;

    if (urls.length === 0) {
      await supabaseAdmin
        .from("clwrota_sync_state")
        .upsert({
          id: 1,
          last_sync_at: new Date().toISOString(),
          last_status: "no_report_urls_configured",
          last_error: "Add at least one report URL in Settings before syncing.",
          last_pulled_rows: 0,
        });
      return { ok: false, message: "No report URLs configured.", details: [] };
    }

    const details: Array<{ name: string; rows: number; bytes: number; error?: string }> = [];
    let totalRows = 0;
    let firstError: string | null = null;

    for (const [name, url] of urls) {
      try {
        const { rows, bytes } = await fetchReport(url, apiKey);
        details.push({ name, rows, bytes });
        totalRows += rows;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        details.push({ name, rows: 0, bytes: 0, error: msg });
        if (!firstError) firstError = msg;
      }
    }

    await supabaseAdmin
      .from("clwrota_sync_state")
      .upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: firstError ? "partial_failure" : "success",
        last_error: firstError,
        last_pulled_rows: totalRows,
      });

    return {
      ok: !firstError,
      message: firstError
        ? `Pulled ${totalRows} rows with errors.`
        : `Pulled ${totalRows} rows from CLWRota.`,
      details,
    };
  });

// =====================================================================
// Rota sync
// =====================================================================

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
  | "non_clinical";

const NON_PATIENT_FACING_DUTY_TYPES: ReadonlySet<ResolvedDutyType> = new Set([
  "spa",
  "admin",
  "teaching",
  "non_clinical",
]);

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

async function loadDutyTypeMappings(): Promise<DutyTypeMappingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("duty_type_mappings")
    .select("duty_type, pattern, match_type, grade_filter, trainee_seniority_filter, priority, active")
    .eq("active", true)
    .order("priority", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as DutyTypeMappingRow[];
}



/**
 * Pull rota assignments from the configured CLWRota rota report URL and
 * write them to `theatre_sessions` + `rota_assignments`. Matches staff by
 * email/external id/name, theatres by name, specialties by name (created on
 * demand). Rows that can't be matched are reported as skipped so the field
 * mapping can be tuned.
 *
 * HISTORICAL-DATA SAFEGUARD: this function never deletes rows.
 * It only upserts theatre_sessions and rota_assignments keyed by natural
 * identifiers, so old/historical assignments outside the synced date window
 * are preserved for auditing.
 */
export const syncClwRotaRota = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    return performRotaSync();
  });

export async function performRotaSync(
  opts: { from?: string; to?: string; daysBack?: number; daysAhead?: number } = {},
) {
    const startedAt = Date.now();
    const { apiKey } = getEnv();

    // --- Historical-data safeguard: record pre-sync counts ---------------
    const { count: preCount, error: preCountErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("id", { count: "exact", head: true })
      .eq("source", "clwrota");
    if (preCountErr) throw new Error(preCountErr.message);
    const preSyncCount = preCount ?? 0;

    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("rota_report_url, sync_days_back, sync_days_ahead, auto_reclassify_trainee_solo")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);
    const autoReclassify = settings?.auto_reclassify_trainee_solo ?? false;


    const url = settings?.rota_report_url;
    const daysBack = opts.daysBack ?? settings?.sync_days_back ?? 30;
    const daysAhead = opts.daysAhead ?? settings?.sync_days_ahead ?? 120;
    const emptyResult = {
      ok: false as boolean,
      message: "",
      total: 0,
      sessionsUpserted: 0,
      assignmentsUpserted: 0,
      skipped: [] as Array<{ label: string; reason: string }>,
      errors: [] as Array<{ label: string; error: string }>,
      warnings: [] as Array<{ label: string; reason: string }>,
      rawPreview: "",
      sampleKeys: [] as string[],
      unmatchedTheatres: [] as string[],
      unmatchedStaff: [] as string[],
    };

    if (!url) {
      return { ...emptyResult, message: "No rota report URL configured." };
    }

    let rows: Record<string, unknown>[];
    let rawPreview = "";
    let sampleKeys: string[] = [];
    let parseError: string | null = null;
    try {
      const windowedUrl =
        opts.from && opts.to
          ? explicitDateWindow(url, opts.from, opts.to)
          : clampDateWindow(url, { daysBack, daysAhead });
      const text = await fetchReportRaw(windowedUrl, apiKey);


      rawPreview = text.slice(0, 500);
      const parsed = parseRows(text);
      rows = parsed.rows;
      parseError = parsed.parseError;
      if (rows.length > 0) sampleKeys = Object.keys(rows[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabaseAdmin.from("clwrota_sync_state").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: "rota_fetch_failed",
        last_error: msg,
      });
      throw new Error(msg);
    }

    if (rows.length === 0) {
      const reason = parseError
        ? `Rota URL returned no recognisable rows. ${parseError}. Preview: ${rawPreview.slice(0, 200)}`
        : `Rota URL returned no recognisable rows. Preview: ${rawPreview.slice(0, 200)}`;
      await supabaseAdmin.from("clwrota_sync_state").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: "rota_no_rows",
        last_error: reason,
        last_pulled_rows: 0,
      });

      return {
        ...emptyResult,
        message: "Rota URL returned 0 rows. See preview below.",
        rawPreview,
        sampleKeys,
      };
    }

    const [{ data: profiles }, { data: theatres }, { data: specialties }, dutyMappings] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, email, full_name, clwrota_external_id, grade, training_level"),
      supabaseAdmin.from("theatres").select("id, name"),
      supabaseAdmin.from("specialties").select("id, name"),
      loadDutyTypeMappings(),
    ]);


    const profByEmail = new Map<string, string>();
    const profByExtId = new Map<string, string>();
    const profByName = new Map<string, string>();
    const profById = new Map<string, { grade: string | null; training_level: string | null }>();
    for (const p of profiles ?? []) {
      if (p.email) profByEmail.set(p.email.toLowerCase(), p.id);
      if (p.clwrota_external_id) profByExtId.set(String(p.clwrota_external_id), p.id);
      if (p.full_name) profByName.set(p.full_name.toLowerCase().trim(), p.id);
      profById.set(p.id, { grade: p.grade ?? null, training_level: p.training_level ?? null });
    }
    const theatreByName = new Map<string, string>();
    for (const t of theatres ?? []) theatreByName.set(t.name.toLowerCase().trim(), t.id);
    const specialtyByName = new Map<string, string>();
    for (const s of specialties ?? []) specialtyByName.set(s.name.toLowerCase().trim(), s.id);

    const skipped: Array<{ label: string; reason: string }> = [];
    const errors: Array<{ label: string; error: string }> = [];
    const warnings: Array<{ label: string; reason: string }> = [];
    const unmatchedTheatres = new Set<string>();
    const unmatchedStaff = new Set<string>();
    // External IDs we explicitly recognise as non-working — any stale
    // rota_assignment row carrying these IDs (created by older syncs before
    // the non-working classifier matured) must be deleted, otherwise they
    // persist as bogus duty_type='theatre' rows with no theatre_session_id
    // and pollute trainee unmatched-row metrics.
    const nonWorkingExtIds = new Set<string>();

    // --- Pass 1: parse rows, match staff/theatre, collect work in memory. -----
    type SessionDraft = {
      session_date: string;
      theatre_id: string;
      session: "am" | "pm" | "eve" | "night";
      specialty_id: string | null;
      // Lowercased/trimmed specialty name as it appeared in the feed. Kept
      // alongside specialty_id so that after Pass 2 inserts any
      // newly-seen specialties we can still resolve an ID for drafts whose
      // specialty didn't exist when the row was first parsed.
      specialty_name_key: string | null;
      surgical_consultant: string | null;
      // True when the raw CLWRota labels for this session match a
      // "non-SAG" keyword (NHH list covered as part of a consultant's NHS
      // job plan rather than private work). Applied as a default; an
      // admin's non_sag_override flag suppresses sync writes.
      is_non_sag: boolean;
    };
    type AssignmentDraft = {
      staff_id: string;
      session_date: string;
      session: "am" | "pm" | "eve" | "night";
      duty_type: ResolvedDutyType;
      role_on_list: ReturnType<typeof normaliseRole>;
      source: "clwrota";
      theatre_session_key: string | null; // resolve after sessions upserted
      clwrota_external_id: string;
      notes: string | null;
    };

    const sessionDraftsByKey = new Map<string, SessionDraft>();
    const assignmentDrafts: AssignmentDraft[] = [];
    const newSpecialtyNames = new Set<string>();

    for (const row of rows) {
      const dateRaw = pick(row, ["date", "session_date", "Date", "rota_date", "day"]);
      const sessRaw =
        pick(row, [
          "session.rota_label", "shift.rota_label",
          "session.name", "shift.name",
          "session", "session_half", "half", "Session", "period", "shift", "time",
          "start_time",
        ]);
      const personEmail = pick(row, ["person.email", "email", "person_email", "Email"]);
      const personExtId = pick(row, [
        "person.local_id", "person.esr_employee_number", "person.assignment_number",
        "person_id", "local_id", "staff_id", "user_id",
      ]);
      const personFirst = pick(row, ["person.first_name"]);
      const personLast = pick(row, ["person.last_name"]);
      const personName =
        pick(row, ["person.rota_name", "person", "person_name", "name", "staff", "Name", "full_name"]) ??
        ([personFirst, personLast].filter(Boolean).join(" ").trim() || null);
      const theatreName = pick(row, [
        "place.name", "place.external_code",
        "theatre", "location", "room", "Theatre", "list", "Location",
      ]);
      const specialtyName = pick(row, [
        "slot_speciality", "service.local_name", "service.long_name",
        "specialty", "speciality", "service", "Specialty", "Service",
      ]);
      const consultantName = pick(row, [
        "slot_titles", "consultant", "surgeon", "surgical_consultant", "Consultant",
      ]);
      const roleRaw = pick(row, [
        "role.name", "assignment_type.name", "place_category.name",
        "role", "duty", "type", "Role", "Duty",
      ]);
      const externalId =
        pick(row, ["id", "rota_id", "assignment_id", "external_id"]) ??
        (personExtId && dateRaw && sessRaw ? `${personExtId}|${dateRaw}|${sessRaw}` : null);

      const session_date = normaliseDate(dateRaw);
      const session = normaliseSession(sessRaw);
      const label = `${dateRaw ?? "?"} ${sessRaw ?? "?"} · ${personName ?? personEmail ?? personExtId ?? "?"}`;

      if (!session_date) { skipped.push({ label, reason: `cannot parse date "${dateRaw ?? ""}"` }); continue; }
      if (!session)      { skipped.push({ label, reason: `cannot parse session "${sessRaw ?? ""}"` }); continue; }
      if (!externalId)   { skipped.push({ label, reason: "no stable external id (need person.local_id + date + session)" }); continue; }

      const dutyLabels = [consultantName, roleRaw, specialtyName, theatreName];
      if (isNonWorkingRotaLabel(dutyLabels)) {
        if (externalId) nonWorkingExtIds.add(externalId);
        skipped.push({ label, reason: "non-working rota label (off/day off/available)" });
        continue;
      }

      let staffId: string | undefined;
      if (personEmail) staffId = profByEmail.get(personEmail.toLowerCase());
      if (!staffId && personExtId) staffId = profByExtId.get(personExtId);
      if (!staffId && personName) staffId = profByName.get(personName.toLowerCase().trim());
      if (!staffId) {
        unmatchedStaff.add(personName ?? personEmail ?? personExtId ?? "(unknown)");
        skipped.push({
          label,
          reason: `staff not found (email=${personEmail ?? "-"}, extId=${personExtId ?? "-"}, name=${personName ?? "-"})`,
        });
        continue;
      }

      // Track date range for prefetching existing assignments later.

      // Collect new specialty names (resolve after pass 1 in one insert).
      let specialtyId: string | null = null;
      let specialtyNameKey: string | null = null;
      if (specialtyName) {
        specialtyNameKey = specialtyName.toLowerCase().trim();
        const existing = specialtyByName.get(specialtyNameKey);
        if (existing) specialtyId = existing;
        else newSpecialtyNames.add(specialtyName);
      }

      let theatreId: string | undefined;
      if (theatreName) {
        theatreId = theatreByName.get(theatreName.toLowerCase().trim());
        if (!theatreId) unmatchedTheatres.add(theatreName);
      }
      // CLWRota frequently puts off-site / non-numbered list locations
      // (NHH, Pain, POAU, Endo, MRI, Cardioversions, Laser, …) in the
      // slot_titles ("consultant") field rather than place.name. If we
      // didn't find a theatre via the location columns but the consultant
      // slot text matches a known theatre name, treat that as the theatre
      // so the row maps to a real theatre_session.
      if (!theatreId && consultantName) {
        const candidate = theatreByName.get(consultantName.toLowerCase().trim());
        if (candidate) theatreId = candidate;
      }
      // Off-site / specialty-room aliases. CLWRota labels vary
      // ("Endoscopy" / "Endo GA" / "Laser (Paeds)" / "NHH Theatre 3" /
      // "NHH T3" / "NHH 3" …) so fall back to keyword matching against the
      // free-text location and slot-title columns.
      if (!theatreId) {
        const aliasText = `${theatreName ?? ""} ${consultantName ?? ""}`;
        theatreId = resolveOffsiteTheatreAlias(aliasText, theatreByName);
      }

      // Classify duty type from free-text labels + staff grade.
      const prof = profById.get(staffId);
      const dutyType = classifyDutyType(
        dutyLabels,
        prof?.grade,
        prof?.training_level,
        dutyMappings,
      );


      let theatreSessionKey: string | null = null;
      if (dutyType === "theatre" && theatreId) {
        theatreSessionKey = `${session_date}|${theatreId}|${session}`;
        // Detect "non-SAG" NHH lists (NHS job-planned work at New Hall
        // Hospital). Matches case-insensitive keywords anywhere in the
        // free-text label columns; sync sets is_non_sag accordingly
        // unless an admin has set non_sag_override on the session.
        const labelBlob = `${theatreName ?? ""} ${consultantName ?? ""} ${specialtyName ?? ""} ${roleRaw ?? ""}`.toLowerCase();
        const isNonSag = /\bnon[\s-]?sag\b|\bnot[\s-]sag\b/.test(labelBlob);
        // Last write wins for surgical_consultant, but for specialty we
        // keep any non-null name/id already collected — otherwise a later
        // row with a blank slot_speciality would wipe the value out and
        // produce "matched-but-no-specialty" rows on trainee dashboards.
        const prior = sessionDraftsByKey.get(theatreSessionKey);
        sessionDraftsByKey.set(theatreSessionKey, {
          session_date,
          theatre_id: theatreId,
          session,
          specialty_id: specialtyId ?? prior?.specialty_id ?? null,
          specialty_name_key: specialtyNameKey ?? prior?.specialty_name_key ?? null,
          surgical_consultant: consultantName ?? prior?.surgical_consultant ?? null,
          is_non_sag: isNonSag || (prior?.is_non_sag ?? false),
        });
      }

      assignmentDrafts.push({
        staff_id: staffId,
        session_date,
        session,
        duty_type: dutyType,
        // Theatre rows keep the parsed role. Non-patient-facing scheduled
        // activities (SPA / admin / teaching / non-clinical) record an
        // appropriate non-clinical role. Everything else (on-call, ICU,
        // obstetrics, CIC) is on-call style.
        role_on_list:
          dutyType === "theatre"
            ? normaliseRole(roleRaw)
            : dutyType === "spa" || dutyType === "admin"
              ? "admin_session"
              : dutyType === "teaching"
                ? "teaching"
                : dutyType === "non_clinical"
                  ? "non_clinical"
                  : "on_call",
        source: "clwrota",
        theatre_session_key: theatreSessionKey,
        clwrota_external_id: externalId,
        notes: NON_PATIENT_FACING_DUTY_TYPES.has(dutyType)
          ? `Non-patient-facing: ${(roleRaw ?? dutyType).trim()}`
          : consultantName
            ? `Surgeon: ${consultantName}`
            : null,
      });
    }

    // --- Pass 2: bulk-insert any new specialties, then refresh the map. -------
    if (newSpecialtyNames.size > 0) {
      const toInsert = Array.from(newSpecialtyNames).map((name) => ({ name }));
      const { data: created, error: specErr } = await supabaseAdmin
        .from("specialties")
        .insert(toInsert)
        .select("id, name");
      if (specErr) {
        errors.push({ label: "(specialties)", error: `bulk insert: ${specErr.message}` });
      } else {
        for (const s of created ?? []) {
          specialtyByName.set(s.name.toLowerCase().trim(), s.id);
        }
      }
    }
    // Back-fill specialty_id on every draft now that the specialty map is
    // fully populated (covers both pre-existing specialties and any just
    // inserted above). This is what auto-fills specialty_id for theatre
    // bookings whose slot_speciality column was set in the feed.
    for (const draft of sessionDraftsByKey.values()) {
      if (!draft.specialty_id && draft.specialty_name_key) {
        const resolved = specialtyByName.get(draft.specialty_name_key);
        if (resolved) draft.specialty_id = resolved;
      }
    }

    // --- Pass 3: bulk-upsert theatre sessions in chunks. ----------------------
    // Split drafts into two batches:
    //   • withSpecialty: upsert the full row, including specialty_id, so a
    //     known specialty overwrites any prior null.
    //   • withoutSpecialty: upsert WITHOUT the specialty_id column so an
    //     existing booking that already has a specialty isn't blanked out
    //     just because today's feed row didn't include one.
    const allDrafts = Array.from(sessionDraftsByKey.values());
    const sessionIdByKey = new Map<string, string>();
    const SESSION_CHUNK = 1000;
    const ASSIGN_CHUNK = 1500;
    let sessionsUpserted = 0;

    const upsertSessions = async (
      rows: Array<Record<string, unknown>>,
    ) => {
      for (let i = 0; i < rows.length; i += SESSION_CHUNK) {
        const chunk = rows.slice(i, i + SESSION_CHUNK);
        const { data, error: sessErr } = await supabaseAdmin
          .from("theatre_sessions")
          // Cast: chunk is a partial-column payload (specialty_id may be
          // omitted on purpose) which doesn't fit the generated row shape.
          .upsert(chunk as never, { onConflict: "session_date,theatre_id,session" })
          .select("id, session_date, theatre_id, session");
        if (sessErr) {
          errors.push({ label: "(theatre_sessions chunk)", error: sessErr.message });
          continue;
        }
        sessionsUpserted += data?.length ?? 0;
        for (const s of data ?? []) {
          sessionIdByKey.set(`${s.session_date}|${s.theatre_id}|${s.session}`, s.id);
        }
      }
    };

    const withSpecialty = allDrafts
      .filter((d) => d.specialty_id != null)
      .map((d) => ({
        session_date: d.session_date,
        theatre_id: d.theatre_id,
        session: d.session,
        specialty_id: d.specialty_id,
        surgical_consultant: d.surgical_consultant,
      }));
    const withoutSpecialty = allDrafts
      .filter((d) => d.specialty_id == null)
      .map((d) => ({
        session_date: d.session_date,
        theatre_id: d.theatre_id,
        session: d.session,
        surgical_consultant: d.surgical_consultant,
      }));
    await upsertSessions(withSpecialty);
    await upsertSessions(withoutSpecialty);

    // --- Pass 3b: apply is_non_sag from the feed, skipping any sessions
    // an admin has manually overridden. Done as two bulk UPDATEs (one
    // per truthiness) to avoid clobbering admin-set values.
    const trueIds: string[] = [];
    const falseIds: string[] = [];
    for (const d of allDrafts) {
      const id = sessionIdByKey.get(`${d.session_date}|${d.theatre_id}|${d.session}`);
      if (!id) continue;
      (d.is_non_sag ? trueIds : falseIds).push(id);
    }
    const applyNonSag = async (ids: string[], value: boolean) => {
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const { error: nsErr } = await supabaseAdmin
          .from("theatre_sessions")
          .update({ is_non_sag: value })
          .in("id", chunk)
          .eq("non_sag_override", false);
        if (nsErr) {
          errors.push({ label: `(is_non_sag=${value} chunk)`, error: nsErr.message });
        }
      }
    };
    if (trueIds.length > 0) await applyNonSag(trueIds, true);
    if (falseIds.length > 0) await applyNonSag(falseIds, false);


    // --- Pass 4: bulk-upsert rota assignments (dedup external id). -----------
    // Dedupe by external id keeping the last occurrence (latest in the feed).
    const assignmentByExtId = new Map<string, AssignmentDraft>();
    for (const a of assignmentDrafts) assignmentByExtId.set(a.clwrota_external_id, a);

    // Skip rows the coordinator has locally edited — they are "locked" and
    // must not be overwritten by upstream sync. Fetch all locked external IDs
    // in a single query covering the date range we just parsed (avoids 70+
    // chunked `.in()` lookups which blow past the Worker subrequest cap).
    const lockedExtIds = new Set<string>();
    const allDates = Array.from(assignmentByExtId.values()).map((a) => a.session_date);
    if (allDates.length > 0) {
      allDates.sort();
      const minDate = allDates[0];
      const maxDate = allDates[allDates.length - 1];
      const { data: lockedRows, error: lockedErr } = await supabaseAdmin
        .from("rota_assignments")
        .select("clwrota_external_id")
        .eq("locally_modified", true)
        .gte("session_date", minDate)
        .lte("session_date", maxDate);
      if (lockedErr) {
        errors.push({ label: "(locked-row lookup)", error: lockedErr.message });
      } else {
        for (const r of lockedRows ?? []) {
          if (r.clwrota_external_id) lockedExtIds.add(r.clwrota_external_id);
        }
      }
    }

    let lockedSkipped = 0;
    const uniqueAssignments = Array.from(assignmentByExtId.values())
      .filter((a) => {
        if (lockedExtIds.has(a.clwrota_external_id)) { lockedSkipped++; return false; }
        return true;
      })
      .map((a) => ({
        staff_id: a.staff_id,
        session_date: a.session_date,
        session: a.session,
        duty_type: a.duty_type,
        role_on_list: a.role_on_list,
        source: a.source,
        theatre_session_id: a.theatre_session_key ? sessionIdByKey.get(a.theatre_session_key) ?? null : null,
        clwrota_external_id: a.clwrota_external_id,
        notes: a.notes,
      }));

    let assignmentsUpserted = 0;
    for (let i = 0; i < uniqueAssignments.length; i += ASSIGN_CHUNK) {
      const chunk = uniqueAssignments.slice(i, i + ASSIGN_CHUNK);
      const { error: asgErr } = await supabaseAdmin
        .from("rota_assignments")
        .upsert(chunk, { onConflict: "clwrota_external_id" });
      if (asgErr) {
        errors.push({ label: `(rota_assignments chunk ${i}-${i + chunk.length})`, error: asgErr.message });
        continue;
      }
      assignmentsUpserted += chunk.length;
    }
    if (lockedSkipped > 0) {
      skipped.push({ label: `locally-modified assignments preserved`, reason: String(lockedSkipped) });
    }

    // --- Pass 5: delete stale rows whose feed row is now recognised as
    // non-working. The upsert path above never touches these (we `continue`
    // before reaching it), so without an explicit delete the row would
    // remain in the database with its original duty_type='theatre'
    // classification — that is the dominant source of "unmatched theatre
    // row" warnings on trainee dashboards. Locally-modified rows are
    // preserved so coordinators don't lose hand edits.
    let nonWorkingCleaned = 0;
    if (nonWorkingExtIds.size > 0) {
      const ids = Array.from(nonWorkingExtIds);
      const DELETE_CHUNK = 500;
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const chunk = ids.slice(i, i + DELETE_CHUNK);
        const { error: delErr, count } = await supabaseAdmin
          .from("rota_assignments")
          .delete({ count: "exact" })
          .in("clwrota_external_id", chunk)
          .eq("locally_modified", false);
        if (delErr) {
          errors.push({ label: `(non-working cleanup chunk ${i}-${i + chunk.length})`, error: delErr.message });
          continue;
        }
        nonWorkingCleaned += count ?? 0;
      }
      if (nonWorkingCleaned > 0) {
        skipped.push({
          label: "stale non-working rows removed",
          reason: `${nonWorkingCleaned} prior rota_assignment row(s) deleted because the upstream label is now recognised as non-working`,
        });
      }
    }

    // --- Suspicious solo-rate validation ---------------------------------
    // A trainee marked "solo" on a theatre session that also has a consultant
    // assigned is almost certainly not actually solo — the clwrota feed
    // defaults role_on_list to "solo" when it can't determine supervision.
    // Flag these so coordinators can correct them before they distort
    // trainee metrics.
    try {
      const upsertedSessionIds = Array.from(
        new Set(
          uniqueAssignments
            .map((a) => a.theatre_session_id)
            .filter((v): v is string => Boolean(v)),
        ),
      );
      const SUSPECT_CHUNK = 200;
      const suspectByStaff = new Map<string, { name: string; sessions: Set<string> }>();
      const suspectIds: string[] = [];
      const suspectSupervisorByAssignment = new Map<string, string | null>();

      for (let i = 0; i < upsertedSessionIds.length; i += SUSPECT_CHUNK) {
        const chunk = upsertedSessionIds.slice(i, i + SUSPECT_CHUNK);
        const { data: rowsForCheck, error: checkErr } = await supabaseAdmin
          .from("rota_assignments")
          .select(
            "id,staff_id,role_on_list,theatre_session_id,session_date,locally_modified,profiles!rota_assignments_staff_id_fkey(grade,full_name,email)",
          )
          .in("theatre_session_id", chunk);
        if (checkErr) {
          errors.push({ label: "(solo-rate validation)", error: checkErr.message });
          break;
        }
        type Row = {
          id: string;
          staff_id: string;
          role_on_list: string;
          theatre_session_id: string | null;
          session_date: string | null;
          locally_modified: boolean | null;
          profiles: { grade: string | null; full_name: string | null; email: string | null };
        };
        const bySession = new Map<string, Row[]>();
        for (const r of (rowsForCheck ?? []) as unknown as Row[]) {
          if (!r.theatre_session_id) continue;
          (bySession.get(r.theatre_session_id) ?? bySession.set(r.theatre_session_id, []).get(r.theatre_session_id)!).push(r);
        }
        for (const sessionRows of bySession.values()) {
          const supervisorRows = sessionRows.filter(
            (r) => r.profiles?.grade === "consultant" || r.profiles?.grade === "sas",
          );
          if (supervisorRows.length === 0) continue;
          const supervisorStaffId =
            supervisorRows.length === 1 ? supervisorRows[0].staff_id : null;
          for (const r of sessionRows) {
            if (r.profiles?.grade === "trainee" && r.role_on_list === "solo") {
              const key = r.staff_id;
              const entry = suspectByStaff.get(key) ?? {
                name: r.profiles.full_name || r.profiles.email || r.staff_id,
                sessions: new Set<string>(),
              };
              entry.sessions.add(r.theatre_session_id!);
              suspectByStaff.set(key, entry);
              // Only auto-reclassify rows that haven't been manually overridden.
              if (!r.locally_modified) {
                suspectIds.push(r.id);
                suspectSupervisorByAssignment.set(r.id, supervisorStaffId);
              }
            }
          }
        }
      }
      if (suspectByStaff.size > 0) {
        const totalSuspect = Array.from(suspectByStaff.values()).reduce(
          (n, e) => n + e.sessions.size,
          0,
        );
        const summaryList = `${Array.from(suspectByStaff.values())
          .slice(0, 8)
          .map((e) => `${e.name} (${e.sessions.size})`)
          .join(", ")}${suspectByStaff.size > 8 ? ", …" : ""}`;

        if (autoReclassify && suspectIds.length > 0) {
          const syncRunId = crypto.randomUUID();
          let reclassified = 0;
          // Group by proposed supervisor so we can update in chunks while still
          // writing a supervisor_id when one is unambiguous on the session.
          const groups = new Map<string, string[]>();
          for (const id of suspectIds) {
            const sup = suspectSupervisorByAssignment.get(id) ?? "__none__";
            const list = groups.get(sup) ?? [];
            list.push(id);
            groups.set(sup, list);
          }
          for (const [sup, ids] of groups) {
            const UPD_CHUNK = 200;
            for (let i = 0; i < ids.length; i += UPD_CHUNK) {
              const idChunk = ids.slice(i, i + UPD_CHUNK);
              const update: { role_on_list: "supervised"; supervisor_id?: string } = {
                role_on_list: "supervised",
              };

              if (sup !== "__none__") update.supervisor_id = sup;
              const { error: updErr } = await supabaseAdmin
                .from("rota_assignments")
                .update(update)
                .in("id", idChunk);
              if (updErr) {
                errors.push({ label: "(auto-reclassify trainee solo)", error: updErr.message });
                break;
              }
              const { error: logErr } = await supabaseAdmin
                .from("rota_reclassification_log")
                .insert(
                  idChunk.map((id) => ({
                    sync_run_id: syncRunId,
                    assignment_id: id,
                    from_role: "solo",
                    to_role: "supervised",
                    reason:
                      sup !== "__none__"
                        ? "consultant/SAS on same theatre_session_id (supervisor set)"
                        : "consultant/SAS on same theatre_session_id",
                  })),
                );
              if (logErr) {
                errors.push({ label: "(auto-reclassify log)", error: logErr.message });
              }
              reclassified += idChunk.length;
            }
          }
          warnings.push({
            label: "Auto-reclassified trainee solo lists (consultant/SAS also on session)",
            reason: `${reclassified} of ${totalSuspect} list(s) across ${suspectByStaff.size} trainee(s) set to supervised (sync run ${syncRunId}): ${summaryList}`,
          });
        } else {
          warnings.push({
            label: "Suspicious solo lists (consultant/SAS also on session)",
            reason: `${totalSuspect} list(s) across ${suspectByStaff.size} trainee(s): ${summaryList}`,
          });
        }
      }

    } catch (e) {
      errors.push({
        label: "(solo-rate validation)",
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // --- Historical-data safeguard: verify no rows were unexpectedly deleted.
    // Logic lives in `evaluateHistoricalSafeguard` so it can be unit-tested
    // independently of Supabase. The non-working cleanup pass above is an
    // expected source of "loss" and is subtracted from the floor.
    const { count: postCount, error: postCountErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("id", { count: "exact", head: true })
      .eq("source", "clwrota");
    if (postCountErr) {
      errors.push({ label: "(historical safeguard)", error: postCountErr.message });
    } else {
      const verdict = evaluateHistoricalSafeguard({
        preSyncCount,
        postSyncCount: postCount ?? 0,
        nonWorkingCleaned,
      });
      if (!verdict.ok) {
        errors.push({ label: "(historical safeguard)", error: verdict.error });
      }
    }

    const summary = `Rota sync: ${rows.length} rows · ${assignmentsUpserted} assignments · ${sessionsUpserted} new sessions · ${skipped.length} skipped · ${warnings.length} warnings · ${errors.length} errors`;
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: errors.length
        ? "rota_partial"
        : warnings.length
          ? "rota_success_with_warnings"
          : "rota_success",
      last_error: errors.length
        ? errors.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join("; ")
        : warnings.length
          ? warnings.slice(0, 3).map((w) => `${w.label}: ${w.reason}`).join("; ")
          : null,
      last_pulled_rows: rows.length,
    });

    const rotaDurationMs = Date.now() - startedAt;
    console.info(
      "[clwrota.metrics]",
      JSON.stringify({
        kind: "rota_sync",
        at: new Date().toISOString(),
        ok: errors.length === 0,
        rows_pulled: rows.length,
        rows_upserted: assignmentsUpserted,
        rows_skipped_validation: skipped.length,
        rows_failed: errors.length,
        warnings_count: warnings.length,
        errors_count: errors.length,
        duration_ms: rotaDurationMs,
      }),
    );
    const rotaNotes = errors.length
      ? errors.slice(0, 3).map((e) => `${e.label}: ${e.error}`).join("; ").slice(0, 1000)
      : warnings.length
        ? warnings.slice(0, 3).map((w) => `${w.label}: ${w.reason}`).join("; ").slice(0, 1000)
        : null;
    const { error: rotaMetricsErr } = await supabaseAdmin
      .from("clwrota_sync_metrics")
      .insert({
        sync_kind: "rota",
        run_at: new Date().toISOString(),
        ok: errors.length === 0,
        duration_ms: rotaDurationMs,
        rows_pulled: rows.length,
        rows_upserted: assignmentsUpserted,
        rows_skipped_validation: skipped.length,
        rows_failed: errors.length,
        errors_count: errors.length,
        rows_deleted: nonWorkingCleaned,
        non_working_cleaned: nonWorkingCleaned,
        notes: rotaNotes,
      });
    if (rotaMetricsErr) {
      console.warn("[clwrota] failed to insert rota sync metrics:", rotaMetricsErr.message);
    }


    // After all assignments are upserted, refresh the "not yet started"
    // trainee predictions so newly-imported future rota rows turn into a
    // predicted start_date and the UI can badge them accordingly.
    let traineeStartPredictions: Awaited<
      ReturnType<typeof import("./trainee-start-dates.functions").predictTraineeStartDatesImpl>
    > | null = null;
    try {
      const mod = await import("./trainee-start-dates.functions");
      traineeStartPredictions = await mod.predictTraineeStartDatesImpl();
    } catch (err) {
      // Non-fatal: log but don't abort the sync.
      console.error("Trainee start-date prediction failed:", err);
    }

    return {
      ok: errors.length === 0,
      message: summary,
      total: rows.length,
      sessionsUpserted,
      assignmentsUpserted,
      skipped,
      warnings,
      errors,
      rawPreview,
      sampleKeys,
      unmatchedTheatres: Array.from(unmatchedTheatres),
      unmatchedStaff: Array.from(unmatchedStaff),
      traineeStartPredictions,
    };
}

// =====================================================================
// Leave sync
// =====================================================================

// Pure classifiers are in their own module so they can be unit-tested and so
// the professional-vs-study split survives every CLWRota upsert.
import {
  classifyLeaveType,
  classifyLeaveStatus,
  type LeaveType,
  type LeaveStatus,
} from "./clwrota-leave-classify";



/**
 * Pull leave from the configured CLWRota leave report URL and upsert into
 * `leave_requests`, keyed by `clwrota_external_id`.
 *
 * HISTORICAL-DATA SAFEGUARD: this function never deletes rows. Old leave
 * outside the synced window is preserved for auditing.
 */
export const syncClwRotaLeave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    return performLeaveSync();
  });

/**
 * List recent CLWRota sync metric rows for the admin reliability dashboard.
 * Default window 30 days; capped at 365.
 */
export const listClwRotaSyncMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      sync_kind: z.enum(["leave", "rota", "staff", "all"]).default("all"),
    }).parse(input ?? {}),
  )
  .handler(async ({ context, data }): Promise<ListClwRotaSyncMetricsResponse> => {
    await assertAdmin(context.userId);
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();
    let q = supabaseAdmin
      .from("clwrota_sync_metrics")
      .select("*")
      .gte("run_at", since)
      .order("run_at", { ascending: true })
      .limit(5000);
    if (data.sync_kind !== "all") q = q.eq("sync_kind", data.sync_kind);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    // Runtime-validate before returning so a stale schema, missing column,
    // or null `is_backfill` is caught at the server boundary instead of in
    // the UI render path.
    return parseListClwRotaSyncMetricsResponse({
      rows: rows ?? [],
      days: data.days,
      sync_kind: data.sync_kind,
    });
  });


export async function performLeaveSync() {
  const startedAt = Date.now();
  const { apiKey } = getEnv();


  // Pre-sync count for the historical-data safeguard.
  const { count: preCount, error: preCountErr } = await supabaseAdmin
    .from("leave_requests")
    .select("id", { count: "exact", head: true })
    .not("clwrota_external_id", "is", null);
  if (preCountErr) throw new Error(preCountErr.message);
  const preSyncCount = preCount ?? 0;

  const { data: settings, error: loadErr } = await supabaseAdmin
    .from("clwrota_sync_state")
    .select("leave_report_url")
    .eq("id", 1)
    .maybeSingle();
  if (loadErr) throw new Error(loadErr.message);

  const emptyResult = {
    ok: false as boolean,
    message: "",
    total: 0,
    upserted: 0,
    skipped: [] as Array<{ label: string; reason: string }>,
    errors: [] as Array<{ label: string; error: string }>,
    rawPreview: "",
    sampleKeys: [] as string[],
    unmatchedStaff: [] as string[],
  };

  const url = ensureLeaveReportFields(settings?.leave_report_url ?? "");
  if (!url) return { ...emptyResult, message: "No leave report URL configured." };

  // CLWRota's leave_events endpoint can otherwise span many years and time
  // out the Worker before any row is upserted. We widen daysBack to 365 so
  // that retrospectively-added leave (most commonly **sick leave**, which
  // is almost always logged after the absence rather than booked in
  // advance) is pulled into Supabase even when the absence ended weeks or
  // months ago. The historical-data safeguard further down still protects
  // any older rows already in the table.
  const boundedUrl = clampDateWindow(url, { daysBack: 365, daysAhead: 240 });

  let rows: Record<string, unknown>[];
  let rawPreview = "";
  let sampleKeys: string[] = [];
  let parseError: string | null = null;
  try {
    const text = await fetchReportRaw(boundedUrl, apiKey);
    rawPreview = text.slice(0, 500);
    const parsed = parseRows(text);
    rows = parsed.rows;
    parseError = parsed.parseError;
    if (rows.length > 0) sampleKeys = Object.keys(rows[0]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: "leave_fetch_failed",
      last_error: msg,
    });
    throw new Error(msg);
  }

  if (rows.length === 0) {
    const reason = parseError
      ? `Leave URL returned no recognisable rows. ${parseError}. Preview: ${rawPreview.slice(0, 200)}`
      : `Leave URL returned no recognisable rows. Preview: ${rawPreview.slice(0, 200)}`;
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: "leave_no_rows",
      last_error: reason,
      last_pulled_rows: 0,
    });
    return { ...emptyResult, message: "Leave URL returned 0 rows.", rawPreview, sampleKeys };
  }


  // Build staff lookup maps.
  const { data: profiles, error: profErr } = await supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, clwrota_external_id");
  if (profErr) throw new Error(profErr.message);

  const profByEmail = new Map<string, string>();
  const profByExtId = new Map<string, string>();
  const profByName = new Map<string, string>();
  for (const p of profiles ?? []) {
    if (p.email) profByEmail.set(p.email.toLowerCase(), p.id);
    if (p.clwrota_external_id) profByExtId.set(String(p.clwrota_external_id), p.id);
    if (p.full_name) profByName.set(p.full_name.toLowerCase().trim(), p.id);
  }

  const skipped: Array<{ label: string; reason: string }> = [];
  const errors: Array<{ label: string; error: string }> = [];
  const unmatchedStaff = new Set<string>();

  type LeaveDraft = {
    staff_id: string;
    type: LeaveType;
    start_date: string;
    end_date: string;
    status: LeaveStatus;
    reason: string | null;
    clwrota_external_id: string;
  };
  const draftsByExtId = new Map<string, LeaveDraft>();

  for (const row of rows) {
    // Defensive per-row try/catch: a single malformed row (unexpected nested
    // shape, exotic value type) must never crash the whole sync. The row is
    // recorded in `skipped` with a clear reason instead.
    try {
      const personEmail = pick(row, ["person.email", "email", "person_email", "Email"]);
      const personExtId = pick(row, [
        "person.local_id", "person.esr_employee_number", "person.assignment_number",
        "person_id", "local_id", "staff_id", "user_id",
      ]);
      const personFirst = pick(row, ["person.first_name"]);
      const personLast = pick(row, ["person.last_name"]);
      const personName =
        pick(row, ["person.rota_name", "person", "person_name", "name", "staff", "Name", "full_name"]) ??
        ([personFirst, personLast].filter(Boolean).join(" ").trim() || null);

      const startRaw = pick(row, [
        "start_date", "from_date", "from", "Start", "Start Date", "start", "date_from", "begin",
        "start_time", "date",
      ]);
      const endRaw = pick(row, [
        "end_date", "to_date", "to", "End", "End Date", "end", "date_to", "finish",
        "end_time", "date",
      ]);
      const typeRaw = pick(row, [
        "leave_type.name", "leave_type", "category.name", "category", "absence_type.name",
        "absence_type", "type", "Type", "reason_category", "kind",
      ]);
      const statusRaw = pick(row, [
        "leave_request.state", "leave_submittal.state",
        "status.name", "status", "state", "Status", "approval_status",
      ]);
      const reasonText = pick(row, [
        "leave_request.details", "leave_submittal.admin_notes",
        "reason", "comment", "comments", "notes", "description", "Notes",
      ]);
      const externalId =
        pick(row, ["leave_request.local_id", "id", "leave_id", "request_id", "external_id"]) ??
        (personExtId && startRaw && endRaw ? `leave|${personExtId}|${startRaw}|${endRaw}` : null);


      const start_date = normaliseDate(startRaw);
      const end_date = normaliseDate(endRaw);
      const label = `${startRaw ?? "?"} → ${endRaw ?? "?"} · ${personName ?? personEmail ?? personExtId ?? "?"}`;

      if (!start_date) { skipped.push({ label, reason: `cannot parse start date "${startRaw ?? ""}"` }); continue; }
      if (!end_date)   { skipped.push({ label, reason: `cannot parse end date "${endRaw ?? ""}"` }); continue; }
      if (end_date < start_date) { skipped.push({ label, reason: `end_date < start_date` }); continue; }
      if (!externalId) { skipped.push({ label, reason: "no stable external id" }); continue; }

      let staffId: string | undefined;
      if (personEmail) staffId = profByEmail.get(personEmail.toLowerCase());
      if (!staffId && personExtId) staffId = profByExtId.get(personExtId);
      if (!staffId && personName) staffId = profByName.get(personName.toLowerCase().trim());
      if (!staffId) {
        unmatchedStaff.add(personName ?? personEmail ?? personExtId ?? "(unknown)");
        skipped.push({
          label,
          reason: `staff not found (email=${personEmail ?? "-"}, extId=${personExtId ?? "-"}, name=${personName ?? "-"})`,
        });
        continue;
      }

      draftsByExtId.set(externalId, {
        staff_id: staffId,
        type: classifyLeaveType(typeRaw, reasonText),
        start_date,
        end_date,
        status: classifyLeaveStatus(statusRaw),
        reason: reasonText,
        clwrota_external_id: externalId,
      });
    } catch (err) {
      skipped.push({
        label: "(malformed row)",
        reason: `unexpected error processing row: ${err instanceof Error ? err.message : String(err)}`,
      });
      console.warn("[clwrota] malformed leave row skipped:", err);
      continue;
    }
  }


  const drafts = Array.from(draftsByExtId.values());

  // Upsert in chunks, keyed by clwrota_external_id. Never delete.
  //
  // Resilience policy:
  //  1. Try the whole chunk first (fast path — 1000 rows in one round-trip).
  //  2. On any chunk error, retry the chunk with exponential backoff
  //     (1s, 2s, 4s + jitter, max 3 attempts) — covers transient DB / network
  //     blips without losing a thousand rows.
  //  3. If the chunk still fails, fall back to per-row upserts so a single
  //     poisonous row can't take down the surrounding 999 valid rows. Each
  //     per-row attempt also retries with backoff. Successes count toward
  //     `upserted`; failures are recorded in `errors` and the loop continues.
  const CHUNK = 1000;
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 1000;

  // -----------------------------------------------------------------------
  // Reliability metrics
  // -----------------------------------------------------------------------
  // Tracked across the whole sync so admins/dashboards can monitor health
  // over time (fetch retries, write retries, fallback rate, per-row failure
  // rate). Returned in the function result, logged as a structured JSON line
  // for log-aggregation tools, and summarised into `clwrota_sync_state` so
  // even an admin who never reads logs sees the headline numbers.
  const metrics = {
    rows_pulled: rows.length,
    rows_skipped_validation: 0, // updated from `skipped` after the loop
    rows_drafted: drafts.length,
    rows_upserted: 0,
    rows_failed: 0,

    chunks_total: 0,
    chunks_succeeded_first_try: 0,
    chunks_succeeded_after_retry: 0,
    chunks_fell_back_to_per_row: 0,

    per_row_attempts: 0,
    per_row_succeeded: 0,
    per_row_failed: 0,

    upsert_attempts_total: 0,
    upsert_retries_total: 0, // attempts beyond the first
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const backoffDelay = (attempt: number) =>
    Math.min(15000, BASE_DELAY_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);

  /**
   * Upsert a batch with retry/backoff. Returns `{ error, attempts }` where
   * `error` is null on success. Never throws.
   */
  async function upsertWithBackoff(
    batch: LeaveDraft[],
    label: string,
  ): Promise<{ error: string | null; attempts: number }> {
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      metrics.upsert_attempts_total += 1;
      if (attempt > 1) metrics.upsert_retries_total += 1;
      try {
        const { error: upErr } = await supabaseAdmin
          .from("leave_requests")
          .upsert(batch, { onConflict: "clwrota_external_id" });
        if (!upErr) return { error: null, attempts: attempt };
        lastErr = upErr.message;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt < MAX_ATTEMPTS) {
        const delay = backoffDelay(attempt);
        console.warn(
          `[clwrota] upsert failure on ${label} attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delay}ms: ${lastErr}`,
        );
        await sleep(delay);
      }
    }
    return { error: lastErr ?? "unknown upsert failure", attempts: MAX_ATTEMPTS };
  }

  let upserted = 0;
  for (let i = 0; i < drafts.length; i += CHUNK) {
    const chunk = drafts.slice(i, i + CHUNK);
    const chunkLabel = `leave_requests chunk ${i}-${i + chunk.length}`;
    metrics.chunks_total += 1;
    const { error: chunkErr, attempts: chunkAttempts } = await upsertWithBackoff(chunk, chunkLabel);
    if (!chunkErr) {
      upserted += chunk.length;
      if (chunkAttempts === 1) metrics.chunks_succeeded_first_try += 1;
      else metrics.chunks_succeeded_after_retry += 1;
      continue;
    }
    // Chunk failed even after retries — fall back to per-row.
    metrics.chunks_fell_back_to_per_row += 1;
    console.warn(
      `[clwrota] chunk ${chunkLabel} still failing after ${MAX_ATTEMPTS} attempts — falling back to per-row upsert: ${chunkErr}`,
    );
    errors.push({ label: `(${chunkLabel})`, error: `chunk failed after retries: ${chunkErr} — falling back to per-row` });
    let perRowOk = 0;
    let perRowFail = 0;
    for (const draft of chunk) {
      metrics.per_row_attempts += 1;
      const rowLabel = `leave_request ${draft.clwrota_external_id}`;
      const { error: rowErr } = await upsertWithBackoff([draft], rowLabel);
      if (rowErr) {
        perRowFail += 1;
        metrics.per_row_failed += 1;
        errors.push({ label: `(${rowLabel})`, error: rowErr });
      } else {
        perRowOk += 1;
        metrics.per_row_succeeded += 1;
        upserted += 1;
      }
    }
    console.warn(
      `[clwrota] per-row fallback for ${chunkLabel}: ${perRowOk} ok, ${perRowFail} failed`,
    );
  }

  metrics.rows_upserted = upserted;
  metrics.rows_failed = metrics.per_row_failed;
  metrics.rows_skipped_validation = skipped.length;


  // Historical-data safeguard.
  const { count: postCount, error: postCountErr } = await supabaseAdmin
    .from("leave_requests")
    .select("id", { count: "exact", head: true })
    .not("clwrota_external_id", "is", null);
  if (postCountErr) {
    errors.push({ label: "(historical safeguard)", error: postCountErr.message });
  } else if ((postCount ?? 0) < preSyncCount) {
    errors.push({
      label: "(historical safeguard)",
      error: `Historical leave loss: pre ${preSyncCount}, post ${postCount ?? 0}`,
    });
  }

  // Headline summary (one line, admin-readable) + detailed metrics (one
  // structured JSON line for log aggregators like ClickHouse/Loki).
  const summary =
    `Leave sync: ${rows.length} pulled · ${upserted} upserted · ${skipped.length} skipped · ` +
    `${errors.length} errors · ` +
    `chunks ${metrics.chunks_succeeded_first_try}/${metrics.chunks_total} first-try, ` +
    `${metrics.chunks_succeeded_after_retry} retried, ${metrics.chunks_fell_back_to_per_row} fell back · ` +
    `${metrics.upsert_retries_total} write retries`;

  console.info(
    "[clwrota.metrics]",
    JSON.stringify({
      kind: "leave_sync",
      at: new Date().toISOString(),
      ok: errors.length === 0,
      ...metrics,
      errors_count: errors.length,
    }),
  );

  const durationMs = Date.now() - startedAt;

  // Persist a metrics row per run so the admin dashboard can chart
  // reliability over time (retries, fallbacks, failures). Best-effort:
  // a failure here must not break the sync result.
  const { error: metricsInsertErr } = await supabaseAdmin
    .from("clwrota_sync_metrics")
    .insert({
      sync_kind: "leave",
      run_at: new Date().toISOString(),
      ok: errors.length === 0,
      duration_ms: durationMs,
      rows_pulled: metrics.rows_pulled,
      rows_drafted: metrics.rows_drafted,
      rows_upserted: metrics.rows_upserted,
      rows_failed: metrics.rows_failed,
      rows_skipped_validation: metrics.rows_skipped_validation,
      chunks_total: metrics.chunks_total,
      chunks_succeeded_first_try: metrics.chunks_succeeded_first_try,
      chunks_succeeded_after_retry: metrics.chunks_succeeded_after_retry,
      chunks_fell_back_to_per_row: metrics.chunks_fell_back_to_per_row,
      per_row_attempts: metrics.per_row_attempts,
      per_row_succeeded: metrics.per_row_succeeded,
      per_row_failed: metrics.per_row_failed,
      upsert_attempts_total: metrics.upsert_attempts_total,
      upsert_retries_total: metrics.upsert_retries_total,
      errors_count: errors.length,
      notes: errors.length
        ? errors.slice(0, 3).map((e) => `${e.label}: ${e.error}`).join("; ").slice(0, 1000)
        : null,
    });
  if (metricsInsertErr) {
    console.warn("[clwrota] failed to insert sync metrics:", metricsInsertErr.message);
  }

  await supabaseAdmin.from("clwrota_sync_state").upsert({
    id: 1,
    last_sync_at: new Date().toISOString(),
    last_status: errors.length ? "leave_partial" : "leave_success",
    last_error: errors.length
      ? `${summary} || ${errors.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join("; ")}`
      : summary,
    last_pulled_rows: rows.length,
  });


  return {
    ok: errors.length === 0,
    message: summary,
    total: rows.length,
    upserted,
    skipped,
    errors,
    rawPreview,
    sampleKeys,
    unmatchedStaff: Array.from(unmatchedStaff),
    metrics,
  };
}



