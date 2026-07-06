// Server-only loaders for CLWRota admin-configured mapping tables.
// Blocked from client bundles by the .server.ts filename.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { DutyTypeMappingRow } from "./parsing";

export async function loadTheatreNameAliases(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data, error } = await supabaseAdmin
    .from("theatre_name_aliases")
    .select("alias, theatre_id, active")
    .eq("active", true);
  if (error || !data) return out;
  for (const row of data) {
    const key = (row.alias ?? "").toLowerCase().trim();
    if (!key) continue;
    out.set(key, row.theatre_id);
  }
  return out;
}

export async function loadDutyTypeMappings(): Promise<DutyTypeMappingRow[]> {
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
