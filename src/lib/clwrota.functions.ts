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

async function fetchReportRaw(url: string, apiKey: string): Promise<string> {
  const res = await fetch(url, {
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

    // Load existing profiles once, indexed by lower-cased email.
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("id, email");
    if (profErr) throw new Error(profErr.message);
    const byEmail = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.email) byEmail.set(p.email.toLowerCase(), p.id);
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
      const roleLower = roleRaw.toLowerCase();
      let derivedGrade: "consultant" | "sas" | "trainee" | null = null;
      if (roleLower) {
        if (/consultant|attending/.test(roleLower)) derivedGrade = "consultant";
        else if (
          /\b(sas|specialty\s*doctor|specialist\s*doctor|associate\s*specialist|staff\s*grade)\b/.test(
            roleLower,
          )
        )
          derivedGrade = "sas";
        else if (
          /trainee|registrar|resident|fellow|\bst\d+\b|\bct\d+\b|\bspr\b|\bsho\b|\bfy?\d\b|core|foundation/.test(
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

      const profileId = byEmail.get(emailLower);

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
          if (insData?.id) byEmail.set(emailLower, insData.id);
        }
        continue;
      }

      matched++;
      const patch: {
        full_name?: string;
        clwrota_external_id?: string;
        gmc_number?: string;
        start_date?: string;
        grade?: "consultant" | "sas" | "trainee";
        training_level?: string;
        active?: boolean;
      } = {};
      if (fullName) patch.full_name = fullName;
      if (externalId) patch.clwrota_external_id = externalId;
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

/**
 * Pull rota assignments from the configured CLWRota rota report URL and
 * write them to `theatre_sessions` + `rota_assignments`. Matches staff by
 * email/external id/name, theatres by name, specialties by name (created on
 * demand). Rows that can't be matched are reported as skipped so the field
 * mapping can be tuned.
 */
export const syncClwRotaRota = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    return performRotaSync();
  });

export async function performRotaSync() {
    const { apiKey } = getEnv();

    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("rota_report_url")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);

    const url = settings?.rota_report_url;
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
      const text = await fetchReportRaw(url, apiKey);
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
      supabaseAdmin.from("profiles").select("id, email, full_name, clwrota_external_id"),
      supabaseAdmin.from("theatres").select("id, name"),
      supabaseAdmin.from("specialties").select("id, name"),
    ]);

    const profByEmail = new Map<string, string>();
    const profByExtId = new Map<string, string>();
    const profByName = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.email) profByEmail.set(p.email.toLowerCase(), p.id);
      if (p.clwrota_external_id) profByExtId.set(String(p.clwrota_external_id), p.id);
      if (p.full_name) profByName.set(p.full_name.toLowerCase().trim(), p.id);
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
      duty_type: "theatre";
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

      let theatreSessionKey: string | null = null;
      if (theatreId) {
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
        duty_type: "theatre",
        role_on_list: normaliseRole(roleRaw),
        source: "clwrota",
        theatre_session_key: theatreSessionKey,
        clwrota_external_id: externalId,
        notes: consultantName ? `Surgeon: ${consultantName}` : null,
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
    const CHUNK = 500;
    let sessionsUpserted = 0;
    for (let i = 0; i < sessionDrafts.length; i += CHUNK) {
      const chunk = sessionDrafts.slice(i, i + CHUNK);
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

    // --- Pass 4: bulk-upsert rota assignments in chunks (dedup external id). --
    // Dedupe by external id keeping the last occurrence (latest in the feed).
    const assignmentByExtId = new Map<string, AssignmentDraft>();
    for (const a of assignmentDrafts) assignmentByExtId.set(a.clwrota_external_id, a);

    // Skip rows the coordinator has locally edited — they are "locked" and
    // must not be overwritten by the upstream sync.
    const allExtIds = Array.from(assignmentByExtId.keys());
    const lockedExtIds = new Set<string>();
    for (let i = 0; i < allExtIds.length; i += CHUNK) {
      const idChunk = allExtIds.slice(i, i + CHUNK);
      const { data: lockedRows, error: lockedErr } = await supabaseAdmin
        .from("rota_assignments")
        .select("clwrota_external_id")
        .eq("locally_modified", true)
        .in("clwrota_external_id", idChunk);
      if (lockedErr) {
        errors.push({ label: `(locked-row lookup chunk ${i})`, error: lockedErr.message });
        continue;
      }
      for (const r of lockedRows ?? []) {
        if (r.clwrota_external_id) lockedExtIds.add(r.clwrota_external_id);
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
    for (let i = 0; i < uniqueAssignments.length; i += CHUNK) {
      const chunk = uniqueAssignments.slice(i, i + CHUNK);
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

