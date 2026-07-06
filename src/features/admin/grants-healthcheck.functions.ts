import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Health check: verifies that the listed public-schema tables are reachable
 * via the Data API for the *signed-in user*. Returns a list of tables that
 * fail with a permission error, so the caller can show a clear "missing
 * GRANTs" banner instead of letting the page surface a raw "permission
 * denied for table X" from the first failing query.
 *
 * Uses the same auth context as the page itself (publishable key + bearer
 * token), so a successful response guarantees the page's own reads will
 * not be blocked at the GRANT layer for these tables. RLS is unaffected —
 * this only catches the "table not granted to authenticated" failure mode.
 */
export const checkTableGrants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { tables: string[] }) => {
    if (!input || !Array.isArray(input.tables)) {
      throw new Error("tables must be an array of table names");
    }
    const tables = input.tables
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .map((t) => t.trim())
      // Keep it strictly to safe identifiers — the value is used as the
      // PostgREST table name, not as raw SQL, but we still avoid surprises.
      .filter((t) => /^[a-z_][a-z0-9_]*$/i.test(t));
    return { tables };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const results = await Promise.all(
      data.tables.map(async (table) => {
        // `head: true` + `count: 'exact'` avoids transferring rows but
        // still exercises the SELECT GRANT + RLS path that the real page
        // queries use. We don't care about the count value here.
        const { error } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .from(table as any)
          .select("*", { count: "exact", head: true })
          .limit(1);

        if (!error) return { table, ok: true as const };

        const message = error.message ?? "";
        const code = error.code ?? "";
        // Postgres 42501 = insufficient_privilege ("permission denied for
        // table X"). PostgREST returns the same code in `error.code`.
        const isGrantError =
          code === "42501" ||
          /permission denied for (table|relation)/i.test(message);

        return {
          table,
          ok: false as const,
          reason: isGrantError ? "missing_grant" : "other",
          message,
        };
      }),
    );

    const missing = results.filter(
      (r): r is Extract<typeof r, { ok: false }> =>
        !r.ok && r.reason === "missing_grant",
    );
    const otherErrors = results.filter(
      (r): r is Extract<typeof r, { ok: false }> =>
        !r.ok && r.reason === "other",
    );

    return {
      ok: missing.length === 0,
      missing: missing.map((m) => m.table),
      otherErrors: otherErrors.map((e) => ({
        table: e.table,
        message: e.message,
      })),
      checkedAt: new Date().toISOString(),
    };
  });
