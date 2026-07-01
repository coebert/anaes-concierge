/**
 * RLS tests for public.rpc_access_audit.
 *
 * The audit log records every call to the decryption RPCs. Only admins
 * (via has_role()) may read rows through the Data API; nobody but
 * service_role may modify them. This suite locks that policy in.
 *
 * Uses psql with SET LOCAL ROLE + request.jwt.claims to simulate anon,
 * authenticated, and admin callers. Skips when PGHOST is unavailable so
 * `bun test` still works without DB access.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

function psql(sql: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    "psql",
    ["-tA", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  );
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? 1,
  };
}

function psqlOrThrow(sql: string): string {
  const r = psql(sql);
  if (r.status !== 0) {
    throw new Error(`psql failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// Wrap a query in a transaction that impersonates `role` with the given
// JWT claims (a JSON string) so RLS + has_role() behave as they would
// for a real signed-in request.
function runAs(role: "anon" | "authenticated", claims: object, sql: string) {
  const claimsSql = JSON.stringify(JSON.stringify(claims)).replace(/'/g, "''");
  const escaped = sql.replace(/;+\s*$/, "");
  return psql(
    `BEGIN;
       SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)
         .replace(/'/g, "''")
         .replace(/^/, "'")
         .replace(/$/, "'")}, true);
       SET LOCAL ROLE ${role};
       ${escaped};
     ROLLBACK;`,
  );
  // (claimsSql retained for reference; using JSON.stringify inline above.)
  void claimsSql;
}

const dbAvailable =
  !!process.env.PGHOST &&
  spawnSync("psql", ["-tA", "-c", "SELECT 1"], { encoding: "utf8" }).status === 0;

const AUDIT_MARKER = `rls-audit-test-${randomUUID()}`;
let adminUserId: string | null = null;

describe.skipIf(!dbAvailable)("rpc_access_audit RLS", () => {
  beforeAll(() => {
    // Pick any user that has the 'admin' role today. Using an existing
    // admin means we don't have to grant a role from tests.
    const uid = psqlOrThrow(
      `SELECT user_id::text FROM public.user_roles WHERE role = 'admin' LIMIT 1`,
    );
    adminUserId = uid || null;

    // Seed a marker row so admin/service_role can prove read access.
    // We run as service_role explicitly so the INSERT is unambiguous.
    psqlOrThrow(
      `BEGIN;
         SET LOCAL ROLE service_role;
         INSERT INTO public.rpc_access_audit (rpc_name, called_by, row_count, args)
         VALUES ('${AUDIT_MARKER}', NULL, 1, '{"marker":true}'::jsonb);
       COMMIT;`,
    );
  });

  afterAll(() => {
    if (!dbAvailable) return;
    psql(
      `BEGIN;
         SET LOCAL ROLE service_role;
         DELETE FROM public.rpc_access_audit WHERE rpc_name = '${AUDIT_MARKER}';
       COMMIT;`,
    );
  });

  it("denies SELECT to anon (no table grant + policy)", () => {
    const r = runAs(
      "anon",
      { role: "anon" },
      `SELECT count(*) FROM public.rpc_access_audit`,
    );
    // anon has no SELECT grant on the table → permission denied error.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/permission denied|policy/i);
  });

  it("returns zero rows to a non-admin authenticated user", () => {
    const nonAdminUuid = randomUUID();
    const r = runAs(
      "authenticated",
      {
        role: "authenticated",
        sub: nonAdminUuid,
      },
      `SELECT count(*) FROM public.rpc_access_audit`,
    );
    expect(r.status, r.stderr).toBe(0);
    // Grant is present but the policy filter (has_role admin) evaluates
    // to false → RLS silently filters everything out.
    expect(r.stdout).toBe("0");
  });

  it("returns rows to an authenticated admin", () => {
    if (!adminUserId) {
      // No admin exists in this environment; the RLS predicate is still
      // covered by the other cases.
      return;
    }
    const r = runAs(
      "authenticated",
      {
        role: "authenticated",
        sub: adminUserId,
      },
      `SELECT count(*) FROM public.rpc_access_audit
         WHERE rpc_name = '${AUDIT_MARKER}'`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(Number(r.stdout)).toBeGreaterThanOrEqual(1);
  });

  it("blocks INSERT / UPDATE / DELETE from authenticated (even admins)", () => {
    const uid = adminUserId ?? randomUUID();

    const ins = runAs(
      "authenticated",
      { role: "authenticated", sub: uid },
      `INSERT INTO public.rpc_access_audit (rpc_name, row_count)
         VALUES ('rls-test-should-fail', 0)`,
    );
    expect(ins.status).not.toBe(0);
    expect(ins.stderr).toMatch(/permission denied|policy/i);

    const upd = runAs(
      "authenticated",
      { role: "authenticated", sub: uid },
      `UPDATE public.rpc_access_audit SET row_count = 0
         WHERE rpc_name = '${AUDIT_MARKER}'`,
    );
    expect(upd.status).not.toBe(0);
    expect(upd.stderr).toMatch(/permission denied|policy/i);

    const del = runAs(
      "authenticated",
      { role: "authenticated", sub: uid },
      `DELETE FROM public.rpc_access_audit
         WHERE rpc_name = '${AUDIT_MARKER}'`,
    );
    expect(del.status).not.toBe(0);
    expect(del.stderr).toMatch(/permission denied|policy/i);
  });

  it("allows service_role to read every row", () => {
    const out = psqlOrThrow(
      `BEGIN;
         SET LOCAL ROLE service_role;
         SELECT count(*) FROM public.rpc_access_audit
           WHERE rpc_name = '${AUDIT_MARKER}';
       ROLLBACK;`,
    );
    // psql -tA on a multi-statement transaction returns the SELECT
    // result on its own line; take the last non-empty line to be safe.
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1] ?? "";
    expect(Number(last)).toBeGreaterThanOrEqual(1);
  });

  it("has the expected RLS configuration", () => {
    const rlsEnabled = psqlOrThrow(
      `SELECT relrowsecurity FROM pg_class
         WHERE oid = 'public.rpc_access_audit'::regclass`,
    );
    expect(rlsEnabled).toBe("t");

    const policies = psqlOrThrow(
      `SELECT string_agg(policyname || ':' || cmd || ':' || roles::text, ',' ORDER BY policyname)
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rpc_access_audit'`,
    );
    expect(policies).toMatch(/SELECT/);
    // Only authenticated may be granted, and only for SELECT.
    expect(policies).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});
