import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/lib/require-admin";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { evaluateHistoricalSafeguard } from "@/lib/clwrota-historical-safeguard";
import {
  fetchReportRaw,
  parseRows,
  pick,
  normaliseDate,
  ensureLeaveReportFields,
  clampDateWindow,
} from "./parsing";
import { getEnv } from "./settings.functions";

// Pure classifiers are in their own module so they can be unit-tested and so
// the professional-vs-study split survives every CLWRota upsert.
import {
  classifyLeaveType,
  classifyLeaveStatus,
  type LeaveType,
  type LeaveStatus,
} from "@/lib/clwrota-leave-classify";




/**
 * Pull leave from the configured CLWRota leave report URL and upsert into
 * `leave_requests`, keyed by `clwrota_external_id`.
 *
 * HISTORICAL-DATA SAFEGUARD: this function never deletes rows. Old leave
 * outside the synced window is preserved for auditing.
 */
export const syncClwRotaLeave = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    return performLeaveSync();
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
