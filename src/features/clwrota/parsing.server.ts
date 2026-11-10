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
  // A failed read must not import rows with silently unmatched theatres:
  // fail the run (recorded as a failed import window) so it is retried.
  if (error) throw new Error(`Theatre aliases couldn't be loaded: ${error.message}`);
  if (!data) return out;
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
    .select(
      "duty_type, pattern, match_type, grade_filter, trainee_seniority_filter, priority, active",
    )
    .eq("active", true)
    .order("priority", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as DutyTypeMappingRow[];
}
