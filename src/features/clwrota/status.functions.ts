import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/lib/require-admin";
import { SUPABASE_IN_CHUNK } from "@/lib/supabase-chunked";
import { isNonSagRotaLabel } from "@/lib/clwrota-labels";
import {
  parseListClwRotaSyncMetricsResponse,
  type ListClwRotaSyncMetricsResponse,
} from "@/lib/clwrota-metrics-types";
import {
  fetchReportRaw,
  parseRows,
  pick,
  clampDateWindow,
  explicitDateWindow,
  normaliseDate,
  normaliseSession,
  resolveOffsiteTheatreAlias,
} from "./parsing";
import { loadTheatreNameAliases } from "./parsing.server";
import { getEnv } from "./settings.functions";

/**
 * List recent auto-reclassification sync runs (most recent first) with the
 * number of rows changed. Used by the admin UI to offer per-run undo.
 */
export const listReclassificationRuns = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ sync_run_id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
  .middleware([requireAdmin])
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
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { computeSoloCorrections } = await import("@/lib/solo-investigate");

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
      // UUIDs in the URL — cap at SUPABASE_IN_CHUNK (200) so the request
      // never crosses the edge proxy's ~16 KB length limit. A larger chunk
      // (we previously used 500 ≈ 18.5 KB of just the id list) silently
      // truncated, leaving theatre-session enrichment incomplete and feeding
      // "Unknown" specialty rows into trainee metrics.
      const TS_CHUNK = SUPABASE_IN_CHUNK;
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
 * List recent CLWRota sync metric rows for the admin reliability dashboard.
 * Default window 30 days; capped at 365.
 */
export const listClwRotaSyncMetrics = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      sync_kind: z.enum(["leave", "rota", "staff", "all"]).default("all"),
    }).parse(input ?? {}),
  )
  .handler(async ({ context, data }): Promise<ListClwRotaSyncMetricsResponse> => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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





/**
 * Re-fetch the CLWRota rota report, identify every row tagged "[Non-SAG]"
 * (or similar) in any free-text field, and tick the Non-SAG checkbox on the
 * matching theatre_sessions row. Used by the Admin → Settings "Backfill
 * Non-SAG labels" button so admins don't have to wait for the next full
 * rota sync to see flags propagate.
 *
 * - Only updates sessions where `non_sag_override = false` so any deliberate
 *   admin choice on the theatre grid is preserved.
 * - Does NOT touch rota_assignments, specialties, theatre allocations or
 *   any other session field — strictly an is_non_sag = true write.
 */
export const backfillNonSagLabels = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { from?: string; to?: string } | undefined) => input ?? {})
  .handler(async ({ context, data }) => {
    const { apiKey } = getEnv();

    const { data: settings, error: loadErr } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("rota_report_url, sync_days_back, sync_days_ahead")
      .eq("id", 1)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);
    const url = settings?.rota_report_url;
    if (!url) {
      return {
        ok: false,
        message: "No rota report URL configured.",
        rowsScanned: 0,
        rowsTagged: 0,
        sessionsMatched: 0,
        sessionsUpdated: 0,
        sessionsSkippedOverride: 0,
        unmatched: [] as string[],
      };
    }
    const daysBack = settings?.sync_days_back ?? 30;
    const daysAhead = settings?.sync_days_ahead ?? 120;

    const windowedUrl =
      data?.from && data?.to
        ? explicitDateWindow(url, data.from, data.to)
        : clampDateWindow(url, { daysBack, daysAhead });
    const text = await fetchReportRaw(windowedUrl, apiKey);
    const parsed = parseRows(text);
    const rows = parsed.rows;

    const [{ data: theatres }, theatreAliases] = await Promise.all([
      supabaseAdmin.from("theatres").select("id, name"),
      loadTheatreNameAliases(),
    ]);
    const theatreByName = new Map<string, string>();
    for (const t of theatres ?? []) theatreByName.set(t.name.toLowerCase().trim(), t.id);
    // Merge admin-configured aliases (real names always win).
    for (const [aliasKey, theatreId] of theatreAliases) {
      if (!theatreByName.has(aliasKey)) theatreByName.set(aliasKey, theatreId);
    }

    // Build the set of (theatre_id|date|session) keys the feed tags as Non-SAG,
    // PLUS the set of clwrota_external_ids of every individual non-SAG row so
    // we can flag the corresponding rota_assignments rows even when the row
    // doesn't resolve to a specific NHH theatre (e.g. on-call non-SAG, or
    // non-SAG lists where CLWRota didn't populate place.name).
    const taggedKeys = new Set<string>();
    const taggedExtIds = new Set<string>();
    const unmatched = new Set<string>();
    let rowsTagged = 0;

    for (const row of rows) {
      const dateRaw = pick(row, ["date", "session_date", "Date", "rota_date", "day"]);
      const sessRaw = pick(row, [
        "session.rota_label", "shift.rota_label",
        "session.name", "shift.name",
        "session", "session_half", "half", "Session", "period", "shift", "time",
        "start_time",
      ]);
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
      const personName = pick(row, [
        "person.rota_name", "person", "person_name", "name", "staff", "Name", "full_name",
      ]);
      const personExtId = pick(row, [
        "person.local_id", "person.esr_employee_number", "person.assignment_number",
        "person_id", "local_id", "staff_id", "user_id",
      ]);
      const roleRaw = pick(row, [
        "role.name", "assignment_type.name", "place_category.name",
        "role", "duty", "type", "Role", "Duty",
      ]);

      const isNonSag = isNonSagRotaLabel([
        personName,
        consultantName,
        extraTypeName,
        roleRaw,
        theatreName,
        specialtyName,
      ]);
      if (!isNonSag) continue;
      rowsTagged++;

      const session_date = normaliseDate(dateRaw);
      const session = normaliseSession(sessRaw);
      if (!session_date || !session) continue;

      // Record the assignment-level external id so we can flag the row in
      // rota_assignments regardless of whether a theatre resolves below.
      const extId =
        pick(row, ["id", "rota_id", "assignment_id", "external_id"]) ??
        (personExtId && dateRaw && sessRaw ? `${personExtId}|${dateRaw}|${sessRaw}` : null);
      if (extId) taggedExtIds.add(extId);

      // Resolve the theatre using the same fallbacks as the main sync:
      // place.name → slot_titles match → off-site / specialty-room alias.
      let theatreId: string | undefined;
      if (theatreName) theatreId = theatreByName.get(theatreName.toLowerCase().trim());
      if (!theatreId && consultantName) {
        theatreId = theatreByName.get(consultantName.toLowerCase().trim());
      }
      if (!theatreId) {
        theatreId = resolveOffsiteTheatreAlias(
          `${theatreName ?? ""} ${consultantName ?? ""}`,
          theatreByName,
        );
      }
      if (!theatreId) {
        // Theatre-less non-SAG row (e.g. on-call non-SAG). Still recorded via
        // taggedExtIds above so the assignment gets flagged.
        unmatched.add(theatreName ?? consultantName ?? "(no specific theatre)");
        continue;
      }

      taggedKeys.add(`${theatreId}|${session_date}|${session}`);
    }


    // Flag matching rota_assignments rows so the per-assignment is_non_sag
    // marker is in sync with the feed. Runs even when no theatre-keyed
    // sessions matched, because non-SAG on-call / theatre-less rows still
    // need their assignment flagged.
    let assignmentsUpdated = 0;
    if (taggedExtIds.size > 0) {
      const extIds = Array.from(taggedExtIds);
      const ASGN_CHUNK = 500;
      for (let i = 0; i < extIds.length; i += ASGN_CHUNK) {
        const chunk = extIds.slice(i, i + ASGN_CHUNK);
        const { error: updErr, count } = await supabaseAdmin
          .from("rota_assignments")
          .update({ is_non_sag: true }, { count: "exact" })
          .in("clwrota_external_id", chunk)
          .eq("is_non_sag", false);
        if (updErr) throw new Error(updErr.message);
        assignmentsUpdated += count ?? 0;
      }
    }

    if (taggedKeys.size === 0) {
      return {
        ok: true,
        message:
          `Scanned ${rows.length} feed rows · ${rowsTagged} tagged Non-SAG · ` +
          `flagged ${assignmentsUpdated} assignment(s) (no theatre-keyed sessions matched).`,
        rowsScanned: rows.length,
        rowsTagged,
        sessionsMatched: 0,
        sessionsUpdated: 0,
        sessionsSkippedOverride: 0,
        assignmentsUpdated,
        unmatched: Array.from(unmatched),
      };
    }

    // Resolve theatre_session IDs in bulk for every tagged key.
    const dates = Array.from(new Set(Array.from(taggedKeys).map((k) => k.split("|")[1]))).sort();
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];
    const { data: sessionRows, error: sessErr } = await supabaseAdmin
      .from("theatre_sessions")
      .select("id, theatre_id, session_date, session, is_non_sag, non_sag_override")
      .gte("session_date", minDate)
      .lte("session_date", maxDate);
    if (sessErr) throw new Error(sessErr.message);

    const toUpdate: string[] = [];
    let sessionsSkippedOverride = 0;
    let sessionsMatched = 0;
    for (const s of sessionRows ?? []) {
      const key = `${s.theatre_id}|${s.session_date}|${s.session}`;
      if (!taggedKeys.has(key)) continue;
      sessionsMatched++;
      if (s.non_sag_override) { sessionsSkippedOverride++; continue; }
      if (s.is_non_sag) continue;
      toUpdate.push(s.id);
    }

    let sessionsUpdated = 0;
    // UUIDs in the URL — see SUPABASE_IN_CHUNK for the proxy cap rationale.
    const CHUNK = SUPABASE_IN_CHUNK;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      const { error: updErr, count } = await supabaseAdmin
        .from("theatre_sessions")
        .update({ is_non_sag: true }, { count: "exact" })
        .in("id", chunk);
      if (updErr) throw new Error(updErr.message);
      sessionsUpdated += count ?? 0;
    }

    return {
      ok: true,
      message:
        `Scanned ${rows.length} feed rows · ${rowsTagged} tagged Non-SAG · ` +
        `matched ${sessionsMatched} session(s) · updated ${sessionsUpdated}` +
        (assignmentsUpdated > 0
          ? ` · flagged ${assignmentsUpdated} assignment(s)`
          : "") +
        (sessionsSkippedOverride > 0
          ? ` · ${sessionsSkippedOverride} kept due to admin override`
          : ""),
      rowsScanned: rows.length,
      rowsTagged,
      sessionsMatched,
      sessionsUpdated,
      sessionsSkippedOverride,
      assignmentsUpdated,
      unmatched: Array.from(unmatched),
    };

  });
