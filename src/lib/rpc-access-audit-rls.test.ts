/**
 * Contract tests for public.rpc_access_audit.
 *
 * The audit log records every call to the four decryption RPCs. The
 * intended access surface is:
 *   - service_role  → full read/write (RLS-bypassing, admin server code)
 *   - authenticated → SELECT only, and only rows where has_role(uid,'admin')
 *   - anon          → no access
 *
 * We assert this through Postgres catalogs (`has_table_privilege`,
 * `pg_policies`, `pg_class.relrowsecurity`) rather than via SET ROLE,
 * because the sandbox DB user is not a member of the Supabase roles.
 * The predicates are the ground truth PostgREST enforces at request
 * time, so a regression here is a regression in production behavior.
 *
 * Skips gracefully when PGHOST is unavailable.
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

function hasPriv(role: string, priv: string): boolean {
  return psql(`SELECT has_table_privilege('${role}', '${TABLE}', '${priv}')`) === "t";
}

const dbAvailable =
  !!process.env.PGHOST &&
  spawnSync("psql", ["-tA", "-c", "SELECT 1"], { encoding: "utf8" }).status === 0;

describe.skipIf(!dbAvailable)("rpc_access_audit access surface", () => {
  it("has RLS enabled", () => {
    const enabled = psql(
      `SELECT relrowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass`,
    );
    expect(enabled).toBe("t");
  });

  it("anon has no privileges (denied at grant level)", () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(hasPriv("anon", p), `anon must NOT have ${p}`).toBe(false);
    }
  });

  it("authenticated has SELECT only (writes denied at grant level)", () => {
    expect(hasPriv("authenticated", "SELECT")).toBe(true);
    for (const p of ["INSERT", "UPDATE", "DELETE"]) {
      expect(hasPriv("authenticated", p), `authenticated must NOT have ${p}`).toBe(
        false,
      );
    }
  });

  it("service_role has full privileges", () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(hasPriv("service_role", p), `service_role must have ${p}`).toBe(true);
    }
  });

  it("PUBLIC has no privileges (no default grants leaked)", () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(hasPriv("PUBLIC", p), `PUBLIC must NOT have ${p}`).toBe(false);
    }
  });

  it("has exactly one policy, restricted to admin SELECT via has_role()", () => {
    const rows = psql(
      `SELECT policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '')
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'
        ORDER BY policyname`,
    );
    const policies = rows.split("\n").filter((l) => l.trim() !== "");
    expect(policies.length, `expected exactly 1 policy, got: ${rows}`).toBe(1);

    const [, cmd, roles, qual] = policies[0].split("|");
    expect(cmd).toBe("SELECT");
    expect(roles).toContain("authenticated");
    // Predicate must gate on has_role(auth.uid(), 'admin').
    expect(qual).toMatch(/has_role\s*\(\s*auth\.uid\(\)\s*,\s*'admin'/);
  });

  it("has no INSERT/UPDATE/DELETE policies for signed-in users", () => {
    const nonSelect = psql(
      `SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')`,
    );
    expect(nonSelect).toBe("0");
  });
});
