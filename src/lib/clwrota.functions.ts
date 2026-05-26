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
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
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
    const { apiKey } = getEnv();

    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("staff_report_url")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);

    const url = settings?.staff_report_url;
    if (!url) {
      return { ok: false, message: "No staff report URL configured.", matched: 0, updated: 0, unmatched: [] as string[], total: 0 };
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
        inserted: 0,
        unmatched: [] as string[],
        errors: [],
        rawPreview,
        sampleKeys,
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
    let inserted = 0;
    const unmatched: string[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      const email = pick(row, ["email", "email_address", "Email"]);
      const fullName =
        pick(row, ["full_name", "name", "display_name", "Name"]) ?? "";
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

      if (!email) {
        if (fullName) unmatched.push(`${fullName} (no email)`);
        continue;
      }

      const isEndedPast =
        endDate != null &&
        !Number.isNaN(Date.parse(endDate)) &&
        Date.parse(endDate) < Date.now();

      const profileId = byEmail.get(email.toLowerCase());

      if (!profileId) {
        // Create a new profile so the person shows up in the coordinator
        // staff list. They won't have a login until invited separately —
        // the profile id is just a placeholder uuid until then.
        const newRow: {
          id: string;
          email: string;
          full_name: string;
          clwrota_external_id?: string;
          gmc_number?: string;
          start_date?: string;
          active: boolean;
        } = {
          id: crypto.randomUUID(),
          email,
          full_name: fullName || email,
          active: !isEndedPast,
        };
        if (externalId) newRow.clwrota_external_id = externalId;
        if (gmc) newRow.gmc_number = gmc;
        if (startDate) newRow.start_date = startDate;

        const { data: insData, error: insErr } = await supabaseAdmin
          .from("profiles")
          .insert(newRow)
          .select("id")
          .single();
        if (insErr) {
          errors.push(`${email} (insert): ${insErr.message}`);
        } else {
          inserted++;
          if (insData?.id) byEmail.set(email.toLowerCase(), insData.id);
        }
        continue;
      }

      matched++;
      const patch: {
        full_name?: string;
        clwrota_external_id?: string;
        gmc_number?: string;
        start_date?: string;
        active?: boolean;
      } = {};
      if (fullName) patch.full_name = fullName;
      if (externalId) patch.clwrota_external_id = externalId;
      if (gmc) patch.gmc_number = gmc;
      if (startDate) patch.start_date = startDate;
      if (isEndedPast) patch.active = false;

      if (Object.keys(patch).length === 0) continue;

      const { error: upErr } = await supabaseAdmin
        .from("profiles")
        .update(patch)
        .eq("id", profileId);
      if (upErr) {
        errors.push(`${email}: ${upErr.message}`);
      } else {
        updated++;
      }
    }

    const summary = `Staff sync: ${rows.length} rows · ${matched} matched · ${updated} updated · ${inserted} added · ${unmatched.length} skipped`;
    await supabaseAdmin.from("clwrota_sync_state").upsert({
      id: 1,
      last_sync_at: new Date().toISOString(),
      last_status: errors.length ? "staff_partial" : "staff_success",
      last_error: errors.length ? errors.slice(0, 5).join("; ") : null,
      last_pulled_rows: rows.length,
    });

    return {
      ok: errors.length === 0,
      message: summary,
      total: rows.length,
      matched,
      updated,
      inserted,
      unmatched,
      errors,
    };
  });

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
