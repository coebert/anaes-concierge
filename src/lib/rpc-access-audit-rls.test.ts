/**
 * Contract tests for public.rpc_access_audit RLS.
 *
 * On Supabase, default privileges grant CRUD on every public table to
 * anon/authenticated. What actually protects the audit log is:
 *
 *   1. RLS is enabled on the table.
 *   2. The ONLY policy is a SELECT policy scoped to `authenticated`
 *      and gated by has_role(auth.uid(), 'admin').
 *   3. There are NO INSERT / UPDATE / DELETE / ALL policies — so RLS
 *      default-denies every write for anon and authenticated, and
 *      even non-admin authenticated reads return zero rows.
 *   4. service_role has the BYPASSRLS attribute (set by Supabase), so
 *      admin server code can still read/write freely.
 *
 * These four properties are the ground truth that PostgREST enforces
 * per request. A regression here is a regression in production.
 *
 * Skips gracefully when PGHOST is unavailable so `bun test` still runs
 * without DB access.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const TABLE = "public.rpc_access_audit";

function psql(sql: string): string {
  const r = spawnSync(
    "psql",
    ["-tA", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`psql failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

const dbAvailable =
  !!process.env.PGHOST &&
  spawnSync("psql", ["-tA", "-c", "SELECT 1"], { encoding: "utf8" }).status === 0;

describe.skipIf(!dbAvailable)("rpc_access_audit RLS", () => {
  it("has RLS enabled", () => {
    const enabled = psql(
      `SELECT relrowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass`,
    );
    expect(enabled).toBe("t");
  });

  it("service_role has BYPASSRLS (admin server code always reads)", () => {
    const bypass = psql(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'`);
    expect(bypass).toBe("t");
  });

  it("has exactly one policy — admin-only SELECT", () => {
    const rows = psql(
      `SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'`,
    );
    expect(rows).toBe("1");
  });

  it("SELECT policy is scoped to authenticated and gated by has_role admin", () => {
    const row = psql(
      `SELECT cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '')
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'`,
    );
    const [cmd, roles, qual] = row.split("|");
    expect(cmd).toBe("SELECT");
    // Must be scoped to `authenticated` and MUST NOT include `anon` or PUBLIC.
    expect(roles).toContain("authenticated");
    expect(roles).not.toMatch(/\banon\b/);
    expect(roles).not.toMatch(/\bpublic\b/i);
    // Predicate must gate on has_role(auth.uid(), 'admin').
    expect(qual).toMatch(/has_role\s*\(\s*auth\.uid\(\)\s*,\s*'admin'/);
  });

  it("has no INSERT / UPDATE / DELETE / ALL policies (writes default-deny)", () => {
    const bad = psql(
      `SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')`,
    );
    expect(bad).toBe("0");
  });

  it("no permissive policy names anon or PUBLIC anywhere", () => {
    // Belt-and-braces: even if a future migration adds another policy,
    // it must not open the table to anon/PUBLIC.
    const anonRefs = psql(
      `SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'
          AND (roles::text ILIKE '%anon%' OR roles::text = '{public}')`,
    );
    expect(anonRefs).toBe("0");
  });
});
