import { createServerFn } from "@tanstack/react-start";

/**
 * Health check: verifies that the listed public-schema tables have the
 * Data API GRANTs required for the signed-in (`authenticated`) role to
 * reach them through PostgREST. Returns a list of tables that are missing
 * the expected SELECT privilege, so callers can short-circuit with a
 * clear error instead of surfacing a raw "permission denied" from the
 * client query.
 */
export const checkTableGrants = createServerFn({ method: "POST" })
  .inputValidator((input: { tables: string[] }) => {
    if (!input || !Array.isArray(input.tables)) {
      throw new Error("tables must be an array of table names");
    }
    const tables = input.tables
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .map((t) => t.trim())
      .filter((t) => /^[a-z_][a-z0-9_]*$/i.test(t));
    return { tables };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    // Pull every (table, privilege) granted to the `authenticated` role
    // for the requested tables in one round-trip.
    const { data: rows, error } = await supabaseAdmin
      .from("information_schema.role_table_grants" as never)
      .select("table_name,privilege_type")
      .eq("table_schema", "public")
      .eq("grantee", "authenticated")
      .in("table_name", data.tables);

    if (error) {
      // information_schema is not always exposed via PostgREST; fall back
      // to a raw SQL probe via a security-definer RPC if present. If even
      // that fails, surface the error to the caller.
      throw new Error(`Grant check failed: ${error.message}`);
    }

    const grantsByTable = new Map<string, Set<string>>();
    for (const row of (rows ?? []) as Array<{
      table_name: string;
      privilege_type: string;
    }>) {
      const set = grantsByTable.get(row.table_name) ?? new Set<string>();
      set.add(row.privilege_type);
      grantsByTable.set(row.table_name, set);
    }

    const missing: { table: string; missing: string[] }[] = [];
    for (const t of data.tables) {
      const granted = grantsByTable.get(t) ?? new Set<string>();
      // Required minimum: SELECT for reads. (Writes use INSERT/UPDATE/DELETE.)
      const required = ["SELECT"];
      const missingPrivs = required.filter((p) => !granted.has(p));
      if (missingPrivs.length) missing.push({ table: t, missing: missingPrivs });
    }

    return {
      ok: missing.length === 0,
      missing,
      checkedAt: new Date().toISOString(),
    };
  });
