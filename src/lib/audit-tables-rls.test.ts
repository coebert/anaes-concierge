/**
 * Contract tests for audit / log tables in the public schema.
 *
 * Ground truth: audit tables must only accept writes through
 * SECURITY DEFINER trigger / helper functions (log_late_rota_change,
 * log_leave_request_change, log_rpc_access, webhook handlers). Client
 * roles (anon, authenticated) must never have INSERT / UPDATE policies,
 * and no policy may name anon or PUBLIC.
 *
 * These tests assert the *policy shape* — the guarantee PostgREST
 * enforces per request — so a future migration that adds a client-facing
 * write policy on any audit table fails CI here rather than silently in
 * production.
 *
 * Skips gracefully when PGHOST is unavailable so `bun test` still runs
 * without DB access.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

/**
 * Every audit / append-only log table in the public schema. Writes are
 * expected to flow through SECURITY DEFINER functions or trusted server
 * code (service_role), never through client roles.
 *
 * `allowedClientDelete: true` marks the one exception — admins may
 * delete rota_reclassification_log rows to clear stale re-tagging state.
 */
const AUDIT_TABLES: Array<{
  table: string;
  writerFn: string;
  allowedClientDelete?: boolean;
}> = [
  { table: "rota_change_log", writerFn: "public.log_late_rota_change" },
  { table: "leave_change_log", writerFn: "public.log_leave_request_change" },
  { table: "rpc_access_audit", writerFn: "public.log_rpc_access" },
  // Written by the inbound-email webhook via service_role.
  { table: "email_inbound_log", writerFn: "service_role" },
  // Written by the push-dispatch webhook via service_role.
  { table: "push_notification_log", writerFn: "service_role" },
  {
    table: "rota_reclassification_log",
    writerFn: "service_role",
    allowedClientDelete: true,
  },
];

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

describe.skipIf(!dbAvailable)("audit / log tables RLS", () => {
  it("service_role has BYPASSRLS (trusted server writers always succeed)", () => {
    const bypass = psql(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'`,
    );
    expect(bypass).toBe("t");
  });

  describe.each(AUDIT_TABLES)("$table", ({ table, writerFn, allowedClientDelete }) => {
    it("has RLS enabled", () => {
      const enabled = psql(
        `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass`,
      );
      expect(enabled, `${table} does not have RLS enabled`).toBe("t");
    });

    it("has no INSERT / UPDATE / ALL policies (client writes default-deny)", () => {
      const bad = psql(
        `SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = '${table}'
            AND cmd IN ('INSERT', 'UPDATE', 'ALL')`,
      );
      expect(
        bad,
        `${table} has an INSERT/UPDATE/ALL policy — client roles could write directly, bypassing ${writerFn}`,
      ).toBe("0");
    });

    if (!allowedClientDelete) {
      it("has no DELETE policy (audit rows are append-only)", () => {
        const bad = psql(
          `SELECT count(*) FROM pg_policies
            WHERE schemaname = 'public' AND tablename = '${table}'
              AND cmd = 'DELETE'`,
        );
        expect(bad, `${table} has a DELETE policy — audit rows must be tamper-resistant`).toBe("0");
      });
    }

    it("no policy grants access to anon or PUBLIC", () => {
      const anonRefs = psql(
        `SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = '${table}'
            AND (roles::text ILIKE '%anon%' OR roles::text = '{public}')`,
      );
      expect(
        anonRefs,
        `${table} exposes rows to anon or PUBLIC`,
      ).toBe("0");
    });

    it("no permissive policy uses `true` as its qual (broad open policies)", () => {
      // Belt-and-braces: reject any policy predicate that trivially
      // matches every row — audit tables must always gate reads on a
      // role check (has_role admin) or ownership.
      const trivial = psql(
        `SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = '${table}'
            AND permissive = 'PERMISSIVE'
            AND (btrim(coalesce(qual, '')) = 'true'
                 OR btrim(coalesce(with_check, '')) = 'true')`,
      );
      expect(
        trivial,
        `${table} has a permissive policy with a trivial 'true' predicate`,
      ).toBe("0");
    });
  });

  it("SECURITY DEFINER writer functions exist and are marked SECURITY DEFINER", () => {
    const definerFns = AUDIT_TABLES
      .map((t) => t.writerFn)
      .filter((w) => w.startsWith("public."));
    for (const fn of definerFns) {
      const bareName = fn.replace(/^public\./, "");
      const secdef = psql(
        `SELECT prosecdef FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname = '${bareName}'
          LIMIT 1`,
      );
      expect(secdef, `${fn} is missing or not SECURITY DEFINER`).toBe("t");
    }
  });
});
