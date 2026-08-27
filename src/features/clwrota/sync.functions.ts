import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/lib/require-admin";
import { SUPABASE_IN_CHUNK } from "@/lib/supabase-chunked";
import {
  isNonSagRotaLabel,
  isNonWorkingRotaLabel,
  normaliseRotaLabelText,
} from "@/lib/clwrota-labels";
import { evaluateHistoricalSafeguard } from "@/lib/clwrota-historical-safeguard";
import {
  fetchReportRaw,
  parseRows,
  pick,
  pickTutorialLabel,
  withRollingFutureWindow,
  clampDateWindow,
  explicitDateWindow,
  ensureRotaReportFields,
  normaliseSession,
  sessionsCoveredByTimeRange,
  looksLikeMedicalExaminerLabel,
  looksLikeTutorialLabel,
  normaliseDate,
  normaliseRole,
  classifyDutyType,
  resolveOffsiteTheatreAlias,
  NON_PATIENT_FACING_DUTY_TYPES,
  type ResolvedDutyType,
  type SessionHalf,
} from "./parsing";
import {
  loadTheatreNameAliases,
  loadDutyTypeMappings,
} from "./parsing.server";
import { getEnv } from "./settings.functions";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assignmentNaturalKey,
  dedupeAssignmentsBySyncKeys,
} from "./assignment-dedupe";

export const syncClwRotaStaff = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
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
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
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

export const syncClwRotaRota = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { from?: string; to?: string } | undefined) => input ?? {})
  .handler(async ({ context, data }) => {
    return performRotaSync({ from: data?.from, to: data?.to });
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
    const emptyCoverage = {
      windowFrom: opts.from ?? null,
      windowTo: opts.to ?? null,
      rowsInWindow: 0,
      staffCoverage: [] as Array<{
        staffId: string;
        name: string;
        datesCovered: number;
        firstDate: string;
        lastDate: string;
        insertedDates: number;
        existingDates: number;
      }>,
      skippedReasonCounts: {} as Record<string, number>,
    };
    const emptyResult = {
      ok: false as boolean,
      message: "",
      total: 0,
      sessionsUpserted: 0,
      assignmentsUpserted: 0,
      assignmentsInserted: 0,
      assignmentsUpdated: 0,
      skipped: [] as Array<{ label: string; reason: string }>,
      errors: [] as Array<{ label: string; error: string }>,
      warnings: [] as Array<{ label: string; reason: string }>,
      rawPreview: "",
      sampleKeys: [] as string[],
      unmatchedTheatres: [] as string[],
      unmatchedStaff: [] as string[],
      coverage: emptyCoverage,
    };


    if (!url) {
      return { ...emptyResult, message: "No rota report URL configured." };
    }

    let rows: Record<string, unknown>[];
    let rawPreview = "";
    let sampleKeys: string[] = [];
    let parseError: string | null = null;
    try {
      const withFields = ensureRotaReportFields(url);
      const windowedUrl =
        opts.from && opts.to
          ? explicitDateWindow(withFields, opts.from, opts.to)
          : clampDateWindow(withFields, { daysBack, daysAhead });
      const text = await fetchReportRaw(windowedUrl, apiKey);


      rawPreview = text.slice(0, 500);
      const parsed = parseRows(text);
      rows = parsed.rows;
      parseError = parsed.parseError;
      if (rows.length > 0) sampleKeys = Object.keys(rows[0]);

      // ---- Post-parse date-window filter ---------------------------------
      // The upstream CLWRota report endpoint ignores `start_date`/`end_date`
      // query params and returns the full multi-month dataset regardless
      // of the URL window we sent. That means a "weekly" backfill call
      // still pays the full per-row matching + upsert cost — and the Worker
      // exceeds its CPU budget on long ranges (HTTP 502).
      //
      // To make chunked historical backfills actually complete, filter the
      // parsed rows down to the explicit `from..to` window here (when one
      // was passed). The fetch + parse still touches the whole payload,
      // but every downstream pass (staff matching, theatre_sessions
      // upserts, rota_assignments upserts, non-working cleanup,
      // solo-rate validation) only processes rows inside the window.
      if (opts.from && opts.to) {
        const from = opts.from;
        const to = opts.to;
        const before = rows.length;
        rows = rows.filter((r) => {
          const d = normaliseDate(
            pick(r, ["date", "session_date", "Date", "rota_date", "day"]) ?? null,
          );
          return d != null && d >= from && d <= to;
        });
        console.info(
          `[clwrota] window filter ${from}..${to}: ${rows.length}/${before} rows kept`,
        );
      }
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

    const [
      { data: profiles },
      { data: theatres },
      { data: specialties },
      dutyMappings,
      theatreAliases,
    ] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, email, full_name, clwrota_external_id, grade, training_level"),
      supabaseAdmin.from("theatres").select("id, name"),
      supabaseAdmin.from("specialties").select("id, name"),
      loadDutyTypeMappings(),
      loadTheatreNameAliases(),
    ]);


    const profByEmail = new Map<string, string>();
    const profByExtId = new Map<string, string>();
    const profByName = new Map<string, string>();
    const profById = new Map<string, { grade: string | null; training_level: string | null }>();
    const nameByStaffId = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.email) profByEmail.set(p.email.toLowerCase(), p.id);
      if (p.clwrota_external_id) profByExtId.set(String(p.clwrota_external_id), p.id);
      if (p.full_name) profByName.set(p.full_name.toLowerCase().trim(), p.id);
      profById.set(p.id, { grade: p.grade ?? null, training_level: p.training_level ?? null });
      nameByStaffId.set(p.id, p.full_name ?? p.email ?? p.id);
    }

    const theatreByName = new Map<string, string>();
    for (const t of theatres ?? []) theatreByName.set(t.name.toLowerCase().trim(), t.id);
    // Merge admin-configured aliases so the same lookup chain (exact match,
    // consultant-field fallback, and resolveOffsiteTheatreAlias's internal
    // lookups) all benefit. Real theatre names always win over aliases.
    for (const [aliasKey, theatreId] of theatreAliases) {
      if (!theatreByName.has(aliasKey)) theatreByName.set(aliasKey, theatreId);
    }
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
      is_non_sag: boolean;
      extra_type: string | null;
    };


    const sessionDraftsByKey = new Map<string, SessionDraft>();
    const assignmentDrafts: AssignmentDraft[] = [];
    // Track CLWRota external IDs whose all-day medical_examiner row we've
    // split into `|am` / `|pm` suffixed drafts. Any previously-persisted
    // un-suffixed row with the same external ID must be removed before the
    // upsert so re-sync stays idempotent (no orphan un-suffixed row alongside
    // the two new halves, and no violation of the (staff,date,session)
    // uniqueness constraint from a stale legacy row).
    const splitMeParentExtIds = new Set<string>();
    const newSpecialtyNames = new Set<string>();
    // Theatre-session keys (date|theatreId|session) that the upstream feed
    // tags as Non-SAG on any of their assignments. Detected from "[Non-SAG]"
    // / "(non sag)" markers CLWRota appends to person.rota_name, slot_titles
    // and other free-text fields on NHH-style lists covered as part of NHS
    // job plans. Detection lives in isNonSagRotaLabel (see clwrota-labels.ts).
    const nonSagSessionKeys = new Set<string>();

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
      const personNameRaw =
        pick(row, ["person.rota_name", "person", "person_name", "name", "staff", "Name", "full_name"]) ??
        ([personFirst, personLast].filter(Boolean).join(" ").trim() || null);
      // Strip any "[Non-SAG]" / "(non sag)" tag from the anaesthetist's name
      // before using it for staff matching — CLWRota appends the tag after
      // the rota_name on NHH lists covered as part of NHS job plans
      // ("Dr S Abbas [Non-SAG]"). Without stripping, the name lookup misses
      // because "dr s abbas [non-sag]" doesn't equal "dr s abbas".
      const personName = personNameRaw
        ? personNameRaw
            .replace(/[\s]*[\[\(\{][^\]\)\}]*non[\s-]?sag[^\]\)\}]*[\]\)\}]/gi, "")
            .replace(/[\s,;|\-–—]*\bnon[\s-]?sag\b[\s,;|\-–—]*$/gi, "")
            .trim() || null
        : null;
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
      const extraTypeName = pick(row, [
        "extra_type.name", "extra_type.description", "extra_type.local_id",
        "extra_type_name", "extra_type", "Extra type", "Extra Type",
      ]);
      const roleRaw = pick(row, [
        "role.name", "assignment_type.name", "place_category.name",
        "role", "duty", "type", "Role", "Duty",
      ]);
      // CLWRota free-text note / activity fields. Coordinators frequently
      // record tutorial / lecture topics here ("Tutorial: airway management",
      // "Departmental teaching — obs sim") on rows whose role_raw is just
      // the generic "SPA" / "Consultant" / "Non-patient-facing". Without
      // reading these fields the tutorial audit and calendar overlay miss
      // every such session.
      const rotaNotesRaw = pick(row, [
        // Real Central API assignment reports often store tutorial labels in
        // slot_titles/place.name rather than notes. Examples observed in the
        // live CLWRota payload include "Tutorial / SPA", "Dr Hogan Tutorial",
        // "Airway tutorial:" and "IMT Teaching/ Outpatients".
        "slot_notes",
        "place.name", "place.additional_info",
        "slot_titles",
        "notes", "note", "comment", "comments",
        "session.notes", "session.note", "session.comment",
        "shift.notes", "shift.note", "shift.comment",
        "assignment.notes", "assignment.note", "assignment.comment",
        "activity", "activity.name", "activity_name",
        "session.activity", "shift.activity", "assignment.activity",
        "description", "session.description", "shift.description",
        "assignment.description", "duty.description", "role.description",
        "session_type.description", "assignment_type.description",
        "extra_type.description",
        "details", "session.details", "shift.details",
        "topic", "subject", "title", "session.title", "shift.title",
        "Notes", "Note", "Comment", "Description", "Activity", "Topic",
      ]);
      const rotaNotes = rotaNotesRaw ? String(rotaNotesRaw).trim() || null : null;
      const tutorialNoteRaw = pickTutorialLabel(row, [
        "slot_notes",
        "slot_titles",
        "place.name", "place.additional_info",
        "notes", "note", "comment", "comments",
        "session.notes", "session.note", "session.comment",
        "shift.notes", "shift.note", "shift.comment",
        "assignment.notes", "assignment.note", "assignment.comment",
        "activity", "activity.name", "activity_name",
        "session.activity", "shift.activity", "assignment.activity",
        "description", "session.description", "shift.description",
        "assignment.description", "duty.description", "role.description",
        "session_type.description", "assignment_type.description",
        "extra_type.description",
        "details", "session.details", "shift.details",
        "topic", "subject", "title", "session.title", "shift.title",
        "Notes", "Note", "Comment", "Description", "Activity", "Topic",
      ]);
      const tutorialNote = tutorialNoteRaw ? String(tutorialNoteRaw).trim() || null : null;
      const startTimeRaw = pick(row, ["start_time", "shift.start_time", "session.start_time"]);
      const endTimeRaw = pick(row, ["end_time", "shift.end_time", "session.end_time"]);
      const externalId =
        pick(row, ["id", "rota_id", "assignment_id", "external_id"]) ??
        (personExtId && dateRaw && sessRaw ? `${personExtId}|${dateRaw}|${sessRaw}` : null);

      const session_date = normaliseDate(dateRaw);
      const session = normaliseSession(sessRaw);
      const label = `${dateRaw ?? "?"} ${sessRaw ?? "?"} · ${personName ?? personEmail ?? personExtId ?? "?"}`;

      if (!session_date) { skipped.push({ label, reason: `cannot parse date "${dateRaw ?? ""}"` }); continue; }
      if (!session)      { skipped.push({ label, reason: `cannot parse session "${sessRaw ?? ""}"` }); continue; }
      if (!externalId)   { skipped.push({ label, reason: "no stable external id (need person.local_id + date + session)" }); continue; }

      const rawTutorialLabel = looksLikeTutorialLabel([
        tutorialNote,
        rotaNotes,
        consultantName,
        theatreName,
        specialtyName,
        roleRaw,
        extraTypeName,
      ]);
      const effectiveConsultantName = rawTutorialLabel ? null : consultantName;

      const dutyLabels = [effectiveConsultantName, roleRaw, specialtyName, theatreName, rotaNotes];
      const tutorialLabels = [
        tutorialNote,
        roleRaw,
        theatreName,
        specialtyName,
        effectiveConsultantName,
        extraTypeName,
        sessRaw,
        rotaNotes,
      ];
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
        const aliasText = `${theatreName ?? ""} ${effectiveConsultantName ?? ""}`;
        theatreId = resolveOffsiteTheatreAlias(aliasText, theatreByName);
      }

      // Classify duty type from free-text labels + staff grade.
      const prof = profById.get(staffId);
      const classifiedDutyType = classifyDutyType(
        dutyLabels,
        prof?.grade,
        prof?.training_level,
        dutyMappings,
      );
      // CLWRota often records tutorials as hybrid labels such as
      // "Tutorial/SPA". The generic SPA mapping intentionally has high
      // priority for normal job-plan work, but for tutorial labels we need to
      // promote the row into teaching before SPA/admin can win, otherwise the
      // audit and global-calendar Tutorials row never see it.
      const isTutorial = looksLikeTutorialLabel(tutorialLabels);
      const dutyType: ResolvedDutyType = isTutorial ? "teaching" : classifiedDutyType;

      // Validation: any CLWRota row whose free-text labels clearly describe
      // a Medical Examiner session ("medical examiner", "ME session") must
      // map to duty_type='medical_examiner'. If it didn't, the ME mapping
      // is missing (or a competing mapping is winning) — surface it as a
      // warning so the admin CLWRota status/metrics page shows the row
      // and the admin can add the missing duty_type_mappings entry rather
      // than have the session silently classified as SPA/admin/etc.
      if (
        dutyType !== "medical_examiner" &&
        looksLikeMedicalExaminerLabel([
          roleRaw,
          theatreName,
          specialtyName,
          consultantName,
          extraTypeName,
        ])
      ) {
        warnings.push({
          label,
          reason: `unmapped medical examiner session (classified as ${classifiedDutyType}); add a duty_type_mappings entry for role/theatre/specialty text "${(roleRaw ?? theatreName ?? specialtyName ?? "").slice(0, 80)}"`,
        });
      }


      // Detect Non-SAG markers anywhere in this row's free-text fields.
      // CLWRota tags NHH/non-SAG lists by appending "[Non-SAG]" (or similar)
      // to the consultant slot, person.rota_name, role, theatre or specialty
      // text. If any field on a theatre row carries the tag, the whole list
      // is non-SAG and the theatre-grid Non-SAG flag should be set.
      const isNonSagRow = isNonSagRotaLabel([
        personNameRaw,
        consultantName,
        extraTypeName,
        roleRaw,
        theatreName,
        specialtyName,
      ]);

      let theatreSessionKey: string | null = null;
      if (dutyType === "theatre" && theatreId) {
        theatreSessionKey = `${session_date}|${theatreId}|${session}`;
        if (isNonSagRow) nonSagSessionKeys.add(theatreSessionKey);
        // "non-SAG" classification is normally admin-managed via the
        // theatre-grid Non-SAG checkbox. When the upstream CLWRota feed
        // actually carries a "[Non-SAG]" tag on any field of the row
        // (NHH-style lists covered as part of NHS job plans), we propagate
        // it to theatre_sessions.is_non_sag after the bulk upsert below —
        // but only for sessions whose non_sag_override flag is false, so
        // any admin override on the theatre grid still wins.
        const prior = sessionDraftsByKey.get(theatreSessionKey);
        sessionDraftsByKey.set(theatreSessionKey, {
          session_date,
          theatre_id: theatreId,
          session,
          specialty_id: specialtyId ?? prior?.specialty_id ?? null,
          specialty_name_key: specialtyNameKey ?? prior?.specialty_name_key ?? null,
          surgical_consultant: effectiveConsultantName ?? prior?.surgical_consultant ?? null,
        });
      }


      // Medical examiner sessions in CLWRota are frequently recorded as a
      // single all-day row (e.g. start_time 08:00, end_time 17:00) rather
      // than one AM and one PM row. Without splitting, the assignment
      // shows up in only one column of the global calendar / staff-in-work
      // views. When the shift's start/end range covers both halves of the
      // day, emit a draft per covered half so every rota view reflects the
      // real coverage. All other duty types keep the single-row behaviour.
      const coveredHalves: SessionHalf[] =
        dutyType === "medical_examiner"
          ? (() => {
              const covered = sessionsCoveredByTimeRange(startTimeRaw, endTimeRaw);
              return covered.length > 0 ? covered : [session];
            })()
          : [session];

      const roleOnList =
        dutyType === "theatre"
          ? normaliseRole(roleRaw)
          : dutyType === "spa" || dutyType === "admin"
            ? "admin_session"
            : dutyType === "teaching"
              ? "teaching"
              : dutyType === "non_clinical"
                ? "non_clinical"
                : "on_call";

      // Trainees assigned to a tutorial slot ("Tutorial/SPA") are attending
      // the tutorial, not delivering it. Only consultants and SAS doctors
      // are recorded as tutorial deliverers ("Tutorial: …"); trainees get
      // a "Tutorial (attending): …" note so the audit and the calendar's
      // Tutorials row can exclude them from presenter counts.
      // Prefer CLWRota's own free-text note (topic / activity) when it is
      // distinctive; otherwise fall back to the role / extra_type label.
      const tutorialLabel = (tutorialNote ?? rotaNotes ?? roleRaw ?? extraTypeName ?? "session").trim();
      const isTutorialDeliverer =
        isTutorial && (prof?.grade === "consultant" || prof?.grade === "sas");
      const isTutorialAttendee =
        isTutorial && !isTutorialDeliverer;
      const notes = isTutorialDeliverer
        ? `Tutorial: ${tutorialLabel}`
        : isTutorialAttendee
          ? `Tutorial (attending): ${tutorialLabel}`
          : NON_PATIENT_FACING_DUTY_TYPES.has(dutyType)
            ? `Non-patient-facing: ${(rotaNotes ?? roleRaw ?? dutyType).trim()}`
            : rotaNotes
              ? rotaNotes
              : effectiveConsultantName
                ? `Surgeon: ${effectiveConsultantName}`
                : null;

      for (const half of coveredHalves) {
        // When we synthesise a second half from an all-day ME row the
        // upstream external id would collide across halves and the second
        // upsert would clobber the first. Suffix the external id with the
        // synthesised half so both rows land as distinct assignments.
        const isSplit = coveredHalves.length > 1;
        const extIdForHalf = isSplit ? `${externalId}|${half}` : externalId;
        if (isSplit) splitMeParentExtIds.add(externalId);
        assignmentDrafts.push({
          staff_id: staffId,
          session_date,
          session: half,
          duty_type: dutyType,
          role_on_list: roleOnList,
          source: "clwrota",
          theatre_session_key: half === session ? theatreSessionKey : null,
          clwrota_external_id: extIdForHalf,
          notes,
          is_non_sag: isNonSagRow,
          extra_type: extraTypeName ? String(extraTypeName).trim().toLowerCase() || null : null,
        });
      }
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
    //   • Idempotent rerun: the upsert key (session_date, theatre_id,
    //     session) is a real UNIQUE constraint, so a second sync over the
    //     same window can never insert a duplicate row — every conflicting
    //     row UPDATEs the existing one in place.
    //   • Preserve existing mappings: PostgREST builds the
    //     INSERT...ON CONFLICT DO UPDATE SET clause from the columns
    //     present in the FIRST row of each batch. Any column we OMIT from
    //     the payload is not touched on conflict. We therefore split the
    //     drafts into buckets by which optional columns we actually have
    //     a non-null value for, so a sync that doesn't see a consultant or
    //     specialty for a given booking on this run leaves the previously-
    //     stored value intact instead of blanking it.
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
          // Cast: chunk is a partial-column payload (specialty_id /
          // surgical_consultant may be omitted on purpose) which doesn't
          // fit the generated row shape.
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

    // Bucket drafts by (hasSpecialty, hasConsultant) so each bucket's
    // upsert payload has the same column shape — required by PostgREST and
    // necessary for idempotence: only columns we KNOW a fresh value for
    // are sent, so a missing column on rerun preserves the prior value.
    const sessionBuckets = new Map<string, Array<Record<string, unknown>>>();
    // Every bucket must include at least one NON-key column so PostgREST
    // can generate a valid `ON CONFLICT DO UPDATE SET …` clause. Without
    // it the `__` bucket (rows whose feed has neither specialty nor
    // consultant) ran a key-only INSERT which, on conflict with an
    // existing row, returned no row from RETURNING — so sessionIdByKey
    // never learned that session's id, and every rota_assignment that
    // referenced that key was then saved with theatre_session_id = NULL,
    // making them disappear from /trainees as "unmatched theatre rows".
    // Always writing `updated_at = now()` is the harmless no-op SET that
    // both fixes RETURNING and gives us a sync-touch timestamp for debug.
    const nowIso = new Date().toISOString();
    for (const d of allDrafts) {
      const base: Record<string, unknown> = {
        session_date: d.session_date,
        theatre_id: d.theatre_id,
        session: d.session,
        updated_at: nowIso,
      };
      if (d.specialty_id != null) base.specialty_id = d.specialty_id;
      if (d.surgical_consultant != null) base.surgical_consultant = d.surgical_consultant;
      const key = `${d.specialty_id != null ? "S" : "_"}${d.surgical_consultant != null ? "C" : "_"}`;
      const arr = sessionBuckets.get(key) ?? [];
      arr.push(base);
      sessionBuckets.set(key, arr);
    }
    // Deterministic order keeps the four bucket runs predictable in logs.
    for (const key of ["SC", "S_", "_C", "__"]) {
      const rows = sessionBuckets.get(key);
      if (rows && rows.length) await upsertSessions(rows);
    }

    // Propagate Non-SAG tags detected in the feed onto theatre_sessions.
    // Only sessions with non_sag_override = false are updated, so any admin
    // override on the theatre grid still wins. Runs in chunks against the
    // session IDs resolved during the bulk upsert above.
    let nonSagApplied = 0;
    if (nonSagSessionKeys.size > 0) {
      const ids = Array.from(nonSagSessionKeys)
        .map((k) => sessionIdByKey.get(k))
        .filter((v): v is string => Boolean(v));
      // UUIDs in the URL on a bulk UPDATE — same proxy-truncation risk as
      // bulk reads. Previously 500, which could silently skip flagging some
      // freshly-upserted sessions as non-SAG, leaving them to be counted as
      // ordinary theatre lists by downstream consultant/trainee audits.
      const NON_SAG_CHUNK = SUPABASE_IN_CHUNK;
      for (let i = 0; i < ids.length; i += NON_SAG_CHUNK) {
        const chunk = ids.slice(i, i + NON_SAG_CHUNK);
        const { error: nsErr, count } = await supabaseAdmin
          .from("theatre_sessions")
          .update({ is_non_sag: true }, { count: "exact" })
          .in("id", chunk)
          .eq("non_sag_override", false)
          .eq("is_non_sag", false);
        if (nsErr) {
          errors.push({ label: `(non-SAG flag chunk ${i}-${i + chunk.length})`, error: nsErr.message });
          continue;
        }
        nonSagApplied += count ?? 0;
      }
      if (nonSagApplied > 0) {
        skipped.push({
          label: "non-SAG flags applied from CLWRota",
          reason: `${nonSagApplied} theatre session(s) marked Non-SAG based on upstream tags`,
        });
      }
    }




    // --- Pass 3b: purge stale un-suffixed medical_examiner rows whose all-day
    // CLWRota source has now been split into `|am` / `|pm` halves. Without
    // this, a re-sync would leave the pre-split legacy row alongside the two
    // new halves (duplicate ME assignment for that day), and could also
    // trip the (staff_id, session_date, session) unique constraint on
    // insert. Only purge un-modified CLWRota rows — never touch rows the
    // coordinator has edited locally.
    if (splitMeParentExtIds.size > 0) {
      const parentIds = Array.from(splitMeParentExtIds);
      const PURGE_CHUNK = SUPABASE_IN_CHUNK;
      for (let i = 0; i < parentIds.length; i += PURGE_CHUNK) {
        const ids = parentIds.slice(i, i + PURGE_CHUNK);
        const { error: purgeErr } = await supabaseAdmin
          .from("rota_assignments")
          .delete()
          .in("clwrota_external_id", ids)
          .eq("duty_type", "medical_examiner")
          .eq("locally_modified", false);
        if (purgeErr) {
          errors.push({
            label: `(medical_examiner pre-split purge chunk ${i}-${i + ids.length})`,
            error: purgeErr.message,
          });
        }
      }
    }

    // --- Pass 4: bulk-upsert rota assignments. ------------------------------
    // The database intentionally allows only one row per staff member per
    // half-day. CLWRota sometimes emits multiple rows for the same
    // staff/date/session (for example a generic SPA row plus the tutorial row
    // that explains it). Collapse those before the upsert so one duplicated
    // upstream slot cannot abort the whole sync chunk and prevent newly
    // detected tutorials from reaching the audit.
    const dedupedAssignments = dedupeAssignmentsBySyncKeys(assignmentDrafts);
    if (dedupedAssignments.dropped.length > 0) {
      const duplicateExternalIds = dedupedAssignments.dropped.filter(
        (row) => row.reason === "duplicate_external_id",
      ).length;
      const duplicateStaffSessions = dedupedAssignments.dropped.length - duplicateExternalIds;
      skipped.push({
        label: "duplicate CLWRota assignments collapsed",
        reason: `${dedupedAssignments.dropped.length} duplicate row(s) ignored before upsert (${duplicateExternalIds} repeated external id, ${duplicateStaffSessions} repeated staff/session)`,
      });
    }
    const dedupedDrafts = dedupedAssignments.assignments;

    // Skip rows the coordinator has locally edited — they are "locked" and
    // must not be overwritten by upstream sync. Also remove stale CLWRota rows
    // that have the same staff/date/session but an old external id; otherwise
    // the natural UNIQUE constraint rejects the incoming row even though the
    // source feed is simply replacing a prior assignment id.
    const lockedExtIds = new Set<string>();
    const lockedNaturalKeys = new Set<string>();
    const staleNaturalConflictIds = new Set<string>();
    const incomingByNaturalKey = new Map(
      dedupedDrafts.map((a) => [assignmentNaturalKey(a), a] as const),
    );
    const allDates = dedupedDrafts.map((a) => a.session_date);
    if (allDates.length > 0) {
      allDates.sort();
      const minDate = allDates[0];
      const maxDate = allDates[allDates.length - 1];
      const PAGE_SIZE = 1000;
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: existingRows, error: existingErr } = await supabaseAdmin
          .from("rota_assignments")
          .select("id,clwrota_external_id,staff_id,session_date,session,locally_modified")
          .eq("source", "clwrota")
          .gte("session_date", minDate)
          .lte("session_date", maxDate)
          .order("session_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (existingErr) {
          errors.push({ label: "(existing-assignment lookup)", error: existingErr.message });
          break;
        }
        const page = existingRows ?? [];
        for (const row of page) {
          const existingKey = assignmentNaturalKey({
            staff_id: row.staff_id,
            session_date: row.session_date,
            session: row.session,
          });
          if (row.locally_modified) {
            if (row.clwrota_external_id) lockedExtIds.add(row.clwrota_external_id);
            lockedNaturalKeys.add(existingKey);
            continue;
          }
          const incoming = incomingByNaturalKey.get(existingKey);
          if (
            incoming &&
            row.clwrota_external_id &&
            row.clwrota_external_id !== incoming.clwrota_external_id
          ) {
            staleNaturalConflictIds.add(row.id);
          }
        }
        if (page.length < PAGE_SIZE) break;
      }
    }

    let staleConflictsReplaced = 0;
    if (staleNaturalConflictIds.size > 0) {
      const ids = Array.from(staleNaturalConflictIds);
      for (let i = 0; i < ids.length; i += SUPABASE_IN_CHUNK) {
        const chunk = ids.slice(i, i + SUPABASE_IN_CHUNK);
        const { error: deleteConflictErr, count } = await supabaseAdmin
          .from("rota_assignments")
          .delete({ count: "exact" })
          .in("id", chunk)
          .eq("source", "clwrota")
          .eq("locally_modified", false);
        if (deleteConflictErr) {
          errors.push({
            label: `(stale double-booking cleanup chunk ${i}-${i + chunk.length})`,
            error: deleteConflictErr.message,
          });
          continue;
        }
        staleConflictsReplaced += count ?? 0;
      }
    }
    if (staleConflictsReplaced > 0) {
      skipped.push({
        label: "stale CLWRota assignment ids replaced",
        reason: `${staleConflictsReplaced} old row(s) removed because CLWRota supplied a newer row for the same staff/date/session`,
      });
    }

    let lockedSkipped = 0;
    const uniqueAssignments = dedupedDrafts
      .filter((a) => {
        if (lockedExtIds.has(a.clwrota_external_id)) { lockedSkipped++; return false; }
        if (lockedNaturalKeys.has(assignmentNaturalKey(a))) { lockedSkipped++; return false; }
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
        is_non_sag: a.is_non_sag,
        extra_type: a.extra_type,
      }));


    // Pre-query which of the external IDs we are about to upsert already
    // exist. This lets us distinguish "truly new" assignment rows (insert)
    // from rows that simply had `updated_at` bumped (update). The
    // distinction matters for the rota-gaps tool: only inserts can fill
    // missing dates — bumped updates leave the gap set unchanged, which is
    // why a sync can report thousands of "upserted" rows while filling no
    // gaps at all.
    let preExistingExtIds = new Set<string>();
    if (uniqueAssignments.length > 0) {
      const extIds = uniqueAssignments.map((a) => a.clwrota_external_id);
      const EXIST_CHUNK = SUPABASE_IN_CHUNK;
      for (let i = 0; i < extIds.length; i += EXIST_CHUNK) {
        const ids = extIds.slice(i, i + EXIST_CHUNK);
        const { data: existing, error: existErr } = await supabaseAdmin
          .from("rota_assignments")
          .select("clwrota_external_id")
          .in("clwrota_external_id", ids);
        if (existErr) {
          console.warn("[clwrota] preflight insert/update count failed:", existErr.message);
          preExistingExtIds = new Set<string>();
          break;
        }
        for (const r of existing ?? []) {
          if (r.clwrota_external_id) preExistingExtIds.add(r.clwrota_external_id);
        }
      }
    }

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
    const assignmentsInserted = uniqueAssignments.reduce(
      (n, a) => n + (preExistingExtIds.has(a.clwrota_external_id) ? 0 : 1),
      0,
    );
    const assignmentsUpdated = Math.max(0, assignmentsUpserted - assignmentsInserted);
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

    // Count unmapped Medical Examiner sessions separately so admins see
    // them in the summary/notes and can act on the missing mapping.
    const unmappedMeWarnings = warnings.filter((w) =>
      w.reason.startsWith("unmapped medical examiner session"),
    );
    const meAlert =
      unmappedMeWarnings.length > 0
        ? ` · ${unmappedMeWarnings.length} unmapped ME session${unmappedMeWarnings.length === 1 ? "" : "s"}`
        : "";
    const summary = `Rota sync: ${rows.length} rows · ${assignmentsUpserted} assignments · ${sessionsUpserted} new sessions · ${skipped.length} skipped · ${warnings.length} warnings · ${errors.length} errors${meAlert}`;
    const runOk = errors.length === 0;
    const stateUpdate: Record<string, unknown> = {
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
    };
    // Stamp the "high water mark" only on a fully clean run. Incremental
    // syncs use this timestamp to compute their from..to window, so
    // advancing it on a partial run would cause changes inside the failed
    // slice to be permanently skipped by the next incremental pass.
    if (runOk) stateUpdate.last_successful_rota_sync_at = new Date().toISOString();
    await supabaseAdmin.from("clwrota_sync_state").upsert(stateUpdate);

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
        ? // Surface unmapped-ME warnings first so admins see the missing
          // duty_type_mappings alert even when other warnings are noisier.
          [...unmappedMeWarnings, ...warnings.filter((w) => !unmappedMeWarnings.includes(w))]
            .slice(0, 3)
            .map((w) => `${w.label}: ${w.reason}`)
            .join("; ")
            .slice(0, 1000)
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
      ReturnType<typeof import("@/features/trainees/trainee-start-dates.functions").predictTraineeStartDatesImpl>
    > | null = null;
    try {
      const mod = await import("@/features/trainees/trainee-start-dates.functions");
      traineeStartPredictions = await mod.predictTraineeStartDatesImpl();
    } catch (err) {
      // Non-fatal: log but don't abort the sync.
      console.error("Trainee start-date prediction failed:", err);
    }


    // --- Per-staff coverage diagnostics ----------------------------------
    // For the rota-gaps tool: caller wants to know, for each trainee in
    // the requested window, how many upstream rows came back and which
    // were genuinely new vs. already on file. This lets the UI explain
    // "no gaps filled" precisely (no upstream rows, only stale updates,
    // or every returned date was already covered).
    const datesByStaffCov = new Map<string, Set<string>>();
    const insertedByStaff = new Map<string, Set<string>>();
    const existingByStaff = new Map<string, Set<string>>();
    for (const a of uniqueAssignments) {
      let s = datesByStaffCov.get(a.staff_id);
      if (!s) { s = new Set(); datesByStaffCov.set(a.staff_id, s); }
      s.add(a.session_date);
      const bucket = preExistingExtIds.has(a.clwrota_external_id)
        ? existingByStaff
        : insertedByStaff;
      let b = bucket.get(a.staff_id);
      if (!b) { b = new Set(); bucket.set(a.staff_id, b); }
      b.add(a.session_date);
    }
    const staffCoverage = Array.from(datesByStaffCov.entries()).map(([staffId, dates]) => {
      const sorted = Array.from(dates).sort();
      return {
        staffId,
        name: nameByStaffId.get(staffId) ?? staffId,
        datesCovered: dates.size,
        firstDate: sorted[0],
        lastDate: sorted[sorted.length - 1],
        insertedDates: insertedByStaff.get(staffId)?.size ?? 0,
        existingDates: existingByStaff.get(staffId)?.size ?? 0,
      };
    });
    const skippedReasonCounts: Record<string, number> = {};
    for (const s of skipped) {
      // Bucket by the leading phrase before ":" / "(" so noisy per-row
      // suffixes don't fragment the histogram.
      const key = (s.reason.split(/[:(]/)[0] || s.reason).trim().slice(0, 80);
      skippedReasonCounts[key] = (skippedReasonCounts[key] ?? 0) + 1;
    }
    const coverage = {
      windowFrom: opts.from ?? null,
      windowTo: opts.to ?? null,
      rowsInWindow: rows.length,
      staffCoverage,
      skippedReasonCounts,
    };
    if (opts.from && opts.to) {
      console.info(
        `[clwrota] coverage ${opts.from}..${opts.to}: ${rows.length} rows, ${staffCoverage.length} staff covered, ${assignmentsInserted} insert / ${assignmentsUpdated} update`,
      );
    }

    return {
      ok: errors.length === 0,
      message: summary,
      total: rows.length,
      sessionsUpserted,
      assignmentsUpserted,
      assignmentsInserted,
      assignmentsUpdated,
      skipped,
      warnings,
      errors,
      rawPreview,
      sampleKeys,
      unmatchedTheatres: Array.from(unmatchedTheatres),
      unmatchedStaff: Array.from(unmatchedStaff),
      traineeStartPredictions,
      coverage,
    };

}

/**
 * Slice-by-slice variant of {@link performRotaSync} that walks the live
 * sync window (daysBack..daysAhead) in N-day chunks, calling
 * `performRotaSync({ from, to })` for each slice.
 *
 * Why this exists
 * ---------------
 * The upstream CLWRota report endpoint ignores `start_date`/`end_date`
 * query params and returns the full multi-month dataset regardless of the
 * URL window we sent (see comment in performRotaSync). When the default
 * 150-day window is fetched in one go, `await res.text()` materialises the
 * entire department-wide payload in the Worker's memory and trips the
 * Workers runtime guard:
 *
 *     Memory limit would be exceeded before EOF.
 *
 * Splitting the window into smaller slices keeps the post-parse
 * `theatre_sessions` / `rota_assignments` upsert work bounded per slice
 * (the post-parse window filter discards anything outside [from..to]) and
 * lets the worker GC between slices.
 *
 * The aggregate result mirrors `performRotaSync`'s shape so callers can
 * treat it as a drop-in replacement. Per-slice errors are captured but do
 * NOT abort the run — partial progress is preferable to losing the whole
 * window. The aggregate `ok` flag is true only when every slice succeeded.
 */
export async function performRotaSyncChunked(
  opts: {
    daysBack?: number;
    daysAhead?: number;
    sliceDays?: number;
    /**
     * Hard cap on the number of slices processed in a single invocation.
     * Each slice re-fetches and re-parses the full upstream payload (CLWRota
     * ignores the date window), so an unbounded loop repeatedly allocates a
     * multi-megabyte string + row array and trips the Worker memory limit
     * (502 "Worker exceeded memory limit"). Default 3.
     */
    maxSlices?: number;
  } = {},
): Promise<Awaited<ReturnType<typeof performRotaSync>> & { slices: number; truncated: boolean }> {
  const sliceDays = Math.max(1, opts.sliceDays ?? 30);
  const maxSlices = Math.max(1, opts.maxSlices ?? 3);

  const { data: settings } = await supabaseAdmin
    .from("clwrota_sync_state")
    .select("sync_days_back, sync_days_ahead")
    .eq("id", 1)
    .maybeSingle();
  const daysBack = opts.daysBack ?? settings?.sync_days_back ?? 30;
  const daysAhead = opts.daysAhead ?? settings?.sync_days_ahead ?? 120;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + daysAhead);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  type RotaResult = Awaited<ReturnType<typeof performRotaSync>>;
  const agg: RotaResult & { slices: number } = {
    ok: true,
    message: "",
    total: 0,
    sessionsUpserted: 0,
    assignmentsUpserted: 0,
    assignmentsInserted: 0,
    assignmentsUpdated: 0,
    skipped: [],
    warnings: [],
    errors: [],
    rawPreview: "",
    sampleKeys: [],
    unmatchedTheatres: [],
    unmatchedStaff: [],
    traineeStartPredictions: null,
    coverage: {
      windowFrom: null,
      windowTo: null,
      rowsInWindow: 0,
      staffCoverage: [],
      skippedReasonCounts: {},
    },
    slices: 0,

  };

  const unmatchedT = new Set<string>();
  const unmatchedS = new Set<string>();

  for (let cursor = new Date(start); cursor <= end; ) {
    const sliceEnd = new Date(cursor);
    sliceEnd.setUTCDate(sliceEnd.getUTCDate() + sliceDays - 1);
    if (sliceEnd > end) sliceEnd.setTime(end.getTime());
    const from = fmt(cursor);
    const to = fmt(sliceEnd);
    agg.slices += 1;
    try {
      const r = await performRotaSync({ from, to });
      agg.total += r.total;
      agg.sessionsUpserted += r.sessionsUpserted;
      agg.assignmentsUpserted += r.assignmentsUpserted;
      agg.assignmentsInserted += r.assignmentsInserted ?? 0;
      agg.assignmentsUpdated += r.assignmentsUpdated ?? 0;
      agg.skipped.push(...r.skipped);
      agg.warnings.push(...r.warnings);
      agg.errors.push(...r.errors);
      if (!agg.rawPreview && r.rawPreview) agg.rawPreview = r.rawPreview;
      if (agg.sampleKeys.length === 0 && r.sampleKeys.length > 0) agg.sampleKeys = r.sampleKeys;
      for (const t of r.unmatchedTheatres) unmatchedT.add(t);
      for (const s of r.unmatchedStaff) unmatchedS.add(s);
      if (r.traineeStartPredictions) agg.traineeStartPredictions = r.traineeStartPredictions;
      if (!r.ok) agg.ok = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agg.errors.push({ label: `slice ${from}..${to}`, error: msg });
      agg.ok = false;
      console.error(`[clwrota] rota slice ${from}..${to} failed:`, msg);
    }
    cursor = new Date(sliceEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  agg.unmatchedTheatres = Array.from(unmatchedT);
  agg.unmatchedStaff = Array.from(unmatchedS);
  agg.message = `Chunked rota sync: ${agg.slices} slice(s) of ≤${sliceDays}d, ${agg.assignmentsUpserted} assignments upserted, ${agg.errors.length} error(s).`;
  return agg;
}

/**
 * Incremental rota sync: re-syncs only the date window that may have
 * changed since the last fully-successful rota sync, instead of the
 * full default 30-back / 120-ahead window.
 *
 * Why this exists
 * ---------------
 * The default (chunked) sync re-processes ~150 days of theatre rows on
 * every run, which is the right behaviour for nightly backfills but is
 * wasteful when an admin wants to top up after a small upstream edit, or
 * when a more frequent intra-day cron just needs to pick up today's
 * changes. The incremental mode keeps the upstream fetch — CLWRota
 * ignores `start_date`/`end_date` and returns the full payload anyway —
 * but narrows every downstream pass (staff/theatre matching, upserts,
 * solo-rate validation) to a small window:
 *
 *     from = today − incremental_days_back (overlap, default 3d)
 *     to   = today + incremental_days_ahead (default 14d)
 *
 * The "days back" overlap exists because upstream edits commonly touch
 * rota dates a day or two in the past (late swaps, retroactive duty
 * changes). Always re-syncing a few days back catches those without
 * needing a full window pass.
 *
 * If no prior successful run exists (fresh project, or the high-water
 * mark has never been stamped), we fall back to the chunked full sync so
 * the first run still hydrates the database.
 */
export async function performRotaSyncIncremental(
  opts: { daysBack?: number; daysAhead?: number } = {},
): Promise<Awaited<ReturnType<typeof performRotaSync>> & { mode: "incremental" | "full"; windowFrom: string | null; windowTo: string | null }> {
  const { data: settings } = await supabaseAdmin
    .from("clwrota_sync_state")
    .select("last_successful_rota_sync_at, incremental_days_back, incremental_days_ahead")
    .eq("id", 1)
    .maybeSingle();

  const hasPriorSuccess = !!settings?.last_successful_rota_sync_at;
  if (!hasPriorSuccess) {
    console.info("[clwrota] incremental sync: no prior successful run, falling back to chunked full sync");
    const full = await performRotaSyncChunked();
    return { ...full, mode: "full", windowFrom: null, windowTo: null };
  }

  const daysBack = Math.max(0, opts.daysBack ?? settings?.incremental_days_back ?? 3);
  const daysAhead = Math.max(1, opts.daysAhead ?? settings?.incremental_days_ahead ?? 14);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + daysAhead);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const from = fmt(start);
  const to = fmt(end);

  console.info(`[clwrota] incremental rota sync window ${from}..${to} (last success ${settings.last_successful_rota_sync_at})`);

  const r = await performRotaSync({ from, to });
  return { ...r, mode: "incremental", windowFrom: from, windowTo: to };
}





// =====================================================================
// Leave sync
// =====================================================================
