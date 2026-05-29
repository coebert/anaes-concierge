import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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




async function fetchReportRaw(url: string, apiKey: string): Promise<string> {
  const effectiveUrl = withRollingFutureWindow(url);
  const res = await fetch(effectiveUrl, {
    method: "GET",
    headers: { "X-Auth": apiKey, Accept: "application/json, text/csv;q=0.9" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CLWRota report failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return text;
}

function parseRows(text: string): Record<string, unknown>[] {
  // Try JSON first.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed && typeof parsed === "object") {
      // Common Rotamap shapes: { data: [...] }, { rows: [...] }, { results: [...] },
      // or a top-level key matching the report name e.g. { staff: [...] }, { people: [...] }.
      const obj = parsed as Record<string, unknown>;
      for (const key of ["data", "rows", "results", "staff", "people", "persons", "report", "items"]) {
        if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
      }
      // Fallback: first array-valued property anywhere at the top level.
      for (const v of Object.values(obj)) {
        if (Array.isArray(v) && v.length && typeof v[0] === "object") {
          return v as Record<string, unknown>[];
        }
      }
    }
    return [];
  } catch {
    // CSV fallback — naive parse (no quoted commas). Good enough for Rotamap reports.
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split(",");
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        obj[h] = cells[i]?.trim() ?? "";
      });
      return obj;
    });
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
    try {
      const text = await fetchReportRaw(url, apiKey);
      rawPreview = text.slice(0, 500);
      rows = parseRows(text);
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
      await supabaseAdmin.from("clwrota_sync_state").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: "staff_no_rows",
        last_error: `Staff URL returned no recognisable rows. Response preview: ${rawPreview.slice(0, 200)}`,
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
  // Try JSON first, fall back to CSV row count.
  let rows = 0;
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed)
      ? parsed.length
      : Array.isArray(parsed?.data)
        ? parsed.data.length
        : Array.isArray(parsed?.rows)
          ? parsed.rows.length
          : 0;
  } catch {
    // CSV — count non-empty lines minus header
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

type SessionHalf = "am" | "pm" | "eve" | "night";

function normaliseSession(raw: string | null): SessionHalf | null {
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

function normaliseDate(raw: string | null): string | null {
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

function normaliseRole(
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

type ResolvedDutyType =
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

/**
 * Classify a CLWRota row as a non-theatre duty (on-call, obstetrics, ICU,
 * consultant in charge, SPA, admin, teaching, non-clinical) based on the
 * free-text label fields plus the staff member's grade/training level.
 * Returns "theatre" only when nothing matches.
 */
function classifyDutyType(
  labels: Array<string | null | undefined>,
  grade: string | null | undefined,
  trainingLevel: string | null | undefined,
): ResolvedDutyType {
  const text = labels.filter(Boolean).join(" ").toLowerCase();
  if (!text) return "theatre";

  const isJuniorTrainee = (() => {
    const tl = (trainingLevel ?? "").toUpperCase();
    return tl === "CT1" || tl === "CT2" || tl === "ACCS1" || tl === "ACCS2" || tl === "ACCS3";
  })();

  // Non-patient-facing scheduled activities — check first so labels like
  // "SPA" or "Admin" are preserved rather than swallowed by a generic match.
  if (/\bspa\b/.test(text) || text.includes("supporting professional")) return "spa";
  if (text.includes("teach") || text.includes("education") || text.includes("training session"))
    return "teaching";
  if (
    text.includes("admin") ||
    text.includes("management") ||
    text.includes("audit") ||
    text.includes("appraisal") ||
    text.includes("governance")
  )
    return "admin";

  if (text.includes("consultant in charge") || /\bcic\b/.test(text)) return "consultant_in_charge";

  if (text.includes("obstet")) {
    if (/\b(2nd|second)\b/.test(text)) return "obstetrics_2nd";
    return "obstetrics";
  }

  const mentionsIcu =
    text.includes("icu") || text.includes("intensive") || text.includes("critical care");
  if (mentionsIcu) {
    if (grade === "consultant") return "icu_consultant_oncall";
    if (grade === "trainee") return isJuniorTrainee ? "icu_trainee" : "icu_ct2_plus";
    return "icu_ct2_plus"; // SAS or unknown — closest fit
  }

  const mentionsOnCall =
    text.includes("on call") || text.includes("on-call") || text.includes("oncall");
  if (mentionsOnCall) {
    if (grade === "consultant") return "general_consultant_oncall";
    if (grade === "sas") return "registrar_oncall";
    if (grade === "trainee") return isJuniorTrainee ? "sho_oncall" : "registrar_oncall";
    return "registrar_oncall";
  }

  // Catch-all for explicitly non-clinical scheduled time.
  if ((text.includes("non") && text.includes("clin")) || text.includes("study"))
    return "non_clinical";

  return "theatre";
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

export async function performRotaSync() {
    const { apiKey } = getEnv();

    // --- Historical-data safeguard: record pre-sync counts ---------------
    const { count: preCount, error: preCountErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("id", { count: "exact", head: true })
      .eq("source", "clwrota");
    if (preCountErr) throw new Error(preCountErr.message);
    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("rota_report_url, sync_days_back, sync_days_ahead")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);

    const url = settings?.rota_report_url;
    const daysBack = settings?.sync_days_back ?? 30;
    const daysAhead = settings?.sync_days_ahead ?? 120;
    const emptyResult = {
      ok: false as boolean,
      message: "",
      total: 0,
      sessionsUpserted: 0,
      assignmentsUpserted: 0,
      skipped: [] as Array<{ label: string; reason: string }>,
      errors: [] as Array<{ label: string; error: string }>,
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
    try {
      const text = await fetchReportRaw(clampDateWindow(url, { daysBack, daysAhead }), apiKey);


      rawPreview = text.slice(0, 500);
      rows = parseRows(text);
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
      await supabaseAdmin.from("clwrota_sync_state").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_status: "rota_no_rows",
        last_error: `Rota URL returned no recognisable rows. Preview: ${rawPreview.slice(0, 200)}`,
        last_pulled_rows: 0,
      });
      return {
        ...emptyResult,
        message: "Rota URL returned 0 rows. See preview below.",
        rawPreview,
        sampleKeys,
      };
    }

    const [{ data: profiles }, { data: theatres }, { data: specialties }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, email, full_name, clwrota_external_id, grade, training_level"),
      supabaseAdmin.from("theatres").select("id, name"),
      supabaseAdmin.from("specialties").select("id, name"),
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
    const unmatchedTheatres = new Set<string>();
    const unmatchedStaff = new Set<string>();

    // --- Pass 1: parse rows, match staff/theatre, collect work in memory. -----
    type SessionDraft = {
      session_date: string;
      theatre_id: string;
      session: "am" | "pm" | "eve" | "night";
      specialty_id: string | null;
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
      if (specialtyName) {
        const key = specialtyName.toLowerCase().trim();
        const existing = specialtyByName.get(key);
        if (existing) specialtyId = existing;
        else newSpecialtyNames.add(specialtyName);
      }

      let theatreId: string | undefined;
      if (theatreName) {
        theatreId = theatreByName.get(theatreName.toLowerCase().trim());
        if (!theatreId) unmatchedTheatres.add(theatreName);
      }

      // Classify duty type from free-text labels + staff grade.
      const prof = profById.get(staffId);
      const dutyType = classifyDutyType(
        [consultantName, roleRaw, specialtyName, theatreName],
        prof?.grade,
        prof?.training_level,
      );

      let theatreSessionKey: string | null = null;
      if (dutyType === "theatre" && theatreId) {
        theatreSessionKey = `${session_date}|${theatreId}|${session}`;
        // Last write wins (later rows can fill in specialty/consultant).
        sessionDraftsByKey.set(theatreSessionKey, {
          session_date,
          theatre_id: theatreId,
          session,
          specialty_id: specialtyId,
          surgical_consultant: consultantName ?? null,
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
        // Back-fill specialty_id on session drafts that referenced new names.
        for (const draft of sessionDraftsByKey.values()) {
          if (!draft.specialty_id) {
            // We don't know the original name here; safe to leave null. The
            // assignment loop above only stores specialty_id when it was
            // already known, so newly created specialties attach to sessions
            // on the next sync. (Avoids carrying name around for thousands
            // of rows.)
          }
        }
      }
    }

    // --- Pass 3: bulk-upsert theatre sessions in chunks. ----------------------
    const sessionDrafts = Array.from(sessionDraftsByKey.values());
    const sessionIdByKey = new Map<string, string>();
    const SESSION_CHUNK = 1000;
    const ASSIGN_CHUNK = 1500;
    let sessionsUpserted = 0;
    for (let i = 0; i < sessionDrafts.length; i += SESSION_CHUNK) {
      const chunk = sessionDrafts.slice(i, i + SESSION_CHUNK);
      const { data, error: sessErr } = await supabaseAdmin
        .from("theatre_sessions")
        .upsert(chunk, { onConflict: "session_date,theatre_id,session" })
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

    // --- Historical-data safeguard: verify no rows were deleted ------------
    const { count: postCount, error: postCountErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("id", { count: "exact", head: true })
      .eq("source", "clwrota");
    if (postCountErr) {
      errors.push({ label: "(historical safeguard)", error: postCountErr.message });
    } else if ((postCount ?? 0) < preSyncCount) {
      errors.push({
        label: "(historical safeguard)",
        error: `Historical data loss detected: pre-sync count ${preSyncCount}, post-sync count ${postCount ?? 0}`,
      });
    }

    const summary = `Rota sync: ${rows.length} rows · ${assignmentsUpserted} assignments · ${sessionsUpserted} new sessions · ${skipped.length} skipped · ${errors.length} errors`;
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: errors.length ? "rota_partial" : "rota_success",
      last_error: errors.length
        ? errors.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join("; ")
        : null,
      last_pulled_rows: rows.length,
    });

    return {
      ok: errors.length === 0,
      message: summary,
      total: rows.length,
      sessionsUpserted,
      assignmentsUpserted,
      skipped,
      errors,
      rawPreview,
      sampleKeys,
      unmatchedTheatres: Array.from(unmatchedTheatres),
      unmatchedStaff: Array.from(unmatchedStaff),
    };
}

// =====================================================================
// Leave sync
// =====================================================================

type LeaveType = "annual" | "study" | "compassionate" | "sick" | "parental" | "other";
type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

function classifyLeaveType(raw: string | null): LeaveType {
  const s = (raw ?? "").toLowerCase();
  if (!s) return "other";
  if (s.includes("annual") || s.includes("holiday") || s === "al" || s.includes("vacation"))
    return "annual";
  if (s.includes("study") || s.includes("conference") || s.includes("course") || s === "sl")
    return "study";
  if (s.includes("compassion") || s.includes("bereave")) return "compassionate";
  if (s.includes("sick") || s.includes("illness")) return "sick";
  if (s.includes("matern") || s.includes("patern") || s.includes("parental") || s.includes("adopt"))
    return "parental";
  return "other";
}

function classifyLeaveStatus(raw: string | null): LeaveStatus {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return "approved"; // CLWRota-published leave is already approved
  if (s.includes("approve") || s.includes("confirm") || s.includes("granted") || s === "ok")
    return "approved";
  if (s.includes("reject") || s.includes("deny") || s.includes("declined")) return "rejected";
  if (s.includes("cancel") || s.includes("withdrawn")) return "cancelled";
  if (s.includes("pending") || s.includes("request") || s.includes("await")) return "pending";
  return "approved";
}

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

export async function performLeaveSync() {
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

  let rows: Record<string, unknown>[];
  let rawPreview = "";
  let sampleKeys: string[] = [];
  try {
    const text = await fetchReportRaw(url, apiKey);
    rawPreview = text.slice(0, 500);
    rows = parseRows(text);
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
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: "leave_no_rows",
      last_error: `Leave URL returned no recognisable rows. Preview: ${rawPreview.slice(0, 200)}`,
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
      type: classifyLeaveType(typeRaw),
      start_date,
      end_date,
      status: classifyLeaveStatus(statusRaw),
      reason: reasonText,
      clwrota_external_id: externalId,
    });
  }

  const drafts = Array.from(draftsByExtId.values());

  // Upsert in chunks, keyed by clwrota_external_id. Never delete.
  const CHUNK = 1000;
  let upserted = 0;
  for (let i = 0; i < drafts.length; i += CHUNK) {
    const chunk = drafts.slice(i, i + CHUNK);
    const { error: upErr } = await supabaseAdmin
      .from("leave_requests")
      .upsert(chunk, { onConflict: "clwrota_external_id" });
    if (upErr) {
      errors.push({ label: `(leave_requests chunk ${i}-${i + chunk.length})`, error: upErr.message });
      continue;
    }
    upserted += chunk.length;
  }

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

  const summary = `Leave sync: ${rows.length} rows · ${upserted} upserted · ${skipped.length} skipped · ${errors.length} errors`;
  await supabaseAdmin.from("clwrota_sync_state").upsert({
    id: 1,
    last_sync_at: new Date().toISOString(),
    last_status: errors.length ? "leave_partial" : "leave_success",
    last_error: errors.length
      ? errors.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join("; ")
      : null,
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
  };
}


