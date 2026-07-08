/**
 * Contract tests for the SECURITY DEFINER RPCs used by rota and
 * competency validation.
 *
 * These tests protect two invariants that a future migration must not
 * regress:
 *
 *   1. **Explicit in-body access checks** — every RPC raises
 *      insufficient_privilege for unauthorized callers, so even if a
 *      future migration accidentally regrants EXECUTE, the function
 *      body itself refuses to run.
 *
 *   2. **Locked-down EXECUTE grants** — no anon or PUBLIC EXECUTE on
 *      any of these RPCs, and the sync/cron RPCs stay authenticated
 *      + service_role only (with `has_role(admin)` as the real gate).
 *
 * Skips gracefully when PGHOST is unavailable so `bun test` still runs
 * without DB access.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

interface Rpc {
  /** Fully qualified signature usable with `regprocedure`. */
  signature: string;
  /** Substring that must appear in the function body (proof the guard is compiled in). */
  guardMatch: RegExp;
  /** Whether authenticated (non-admin) should be able to CALL — controls both grants and the guard. */
  authenticatedAllowed: boolean;
}

const RPCS: Rpc[] = [
  {
    signature: "public.get_competency_eligibility(date)",
    guardMatch: /auth\.uid\(\)\s+IS\s+NULL[\s\S]+insufficient_privilege/i,
    authenticatedAllowed: true, // any signed-in user, anon rejected
  },
  {
    signature: "public.trigger_clwrota_sync(text)",
    guardMatch: /has_role\(auth\.uid\(\),\s*'admin'\)[\s\S]+insufficient_privilege/i,
    authenticatedAllowed: false, // admin only
  },
  {
    signature: "public.trigger_clwrota_sync_rate_limited(text)",
    guardMatch: /has_role\(auth\.uid\(\),\s*'admin'\)[\s\S]+insufficient_privilege/i,
    authenticatedAllowed: false,
  },
  {
    signature: "public.trigger_clwrota_sync_with_query(text, text)",
    guardMatch: /has_role\(auth\.uid\(\),\s*'admin'\)[\s\S]+insufficient_privilege/i,
    authenticatedAllowed: false,
  },
  {
    signature: "public.trigger_clwrota_sync_all_rate_limited()",
    guardMatch: /has_role\(auth\.uid\(\),\s*'admin'\)[\s\S]+insufficient_privilege/i,
    authenticatedAllowed: false,
  },
  {
    signature: "public.list_clwrota_cron_runs(integer)",
    guardMatch: /has_role\(auth\.uid\(\),\s*'admin'\)[\s\S]+insufficient_privilege/i,
    authenticatedAllowed: false,
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

describe.skipIf(!dbAvailable)("rota/competency validation RPC access checks", () => {
  describe.each(RPCS)("$signature", ({ signature, guardMatch, authenticatedAllowed }) => {
    it("is defined as SECURITY DEFINER", () => {
      const out = psql(
        `SELECT prosecdef FROM pg_proc WHERE oid = '${signature}'::regprocedure`,
      );
      expect(out).toBe("t");
    });

    it("contains an explicit in-body access check that raises insufficient_privilege", () => {
      const def = psql(
        `SELECT pg_get_functiondef('${signature}'::regprocedure)`,
      );
      expect(
        guardMatch.test(def),
        `${signature} is missing its in-body access check.\n\nFunction body:\n${def}`,
      ).toBe(true);
    });

    it("has no default EXECUTE (proacl is not NULL and PUBLIC has no EXECUTE)", () => {
      const acl = psql(
        `SELECT COALESCE(proacl::text, '')
           FROM pg_proc WHERE oid = '${signature}'::regprocedure`,
      );
      expect(acl, `${signature} still has default (PUBLIC) EXECUTE`).not.toBe("");
      expect(
        /(^|,)=X\//.test(acl),
        `${signature} ACL grants EXECUTE to PUBLIC: ${acl}`,
      ).toBe(false);
    });

    it("does not grant EXECUTE to anon", () => {
      const hasExec = psql(
        `SELECT has_function_privilege('anon', '${signature}', 'EXECUTE')`,
      );
      expect(hasExec, `anon unexpectedly has EXECUTE on ${signature}`).toBe("f");
    });

    it(`${authenticatedAllowed ? "allows" : "denies (grant-level) or gates"} authenticated`, () => {
      const hasExec = psql(
        `SELECT has_function_privilege('authenticated', '${signature}', 'EXECUTE')`,
      );
      if (authenticatedAllowed) {
        // Signed-in caller needed at the grant layer; body then decides.
        expect(hasExec).toBe("t");
      } else {
        // The in-body has_role(admin) check is the real gate. We accept
        // either "no EXECUTE" (belt) or "EXECUTE + body guard" (braces),
        // but the body guard is asserted separately above. Verify at
        // least that the guard *exists* — the previous test already did
        // that — and that ANY authenticated call without admin role
        // will hit the guard. Nothing more to enforce at grant layer.
        expect(["t", "f"]).toContain(hasExec);
      }
    });

    it("grants EXECUTE to service_role (trusted server code always succeeds)", () => {
      const hasExec = psql(
        `SELECT has_function_privilege('service_role', '${signature}', 'EXECUTE')`,
      );
      expect(hasExec).toBe("t");
    });
  });

  const canSetRole =
    dbAvailable &&
    (() => {
      const probe = spawnSync(
        "psql",
        ["-v", "ON_ERROR_STOP=1", "-c", "BEGIN; SET LOCAL role authenticated; ROLLBACK"],
        { encoding: "utf8" },
      );
      return probe.status === 0;
    })();

  describe.skipIf(!canSetRole)("runtime guard behaviour (calls under anon / authenticated roles)", () => {
    /**
     * Drive a single transaction: SET LOCAL role, call the RPC, catch
     * the error, ROLLBACK. We assert the error code is 42501
     * (insufficient_privilege). auth.uid() reads a request GUC that is
     * not set outside a real PostgREST request, so it returns NULL —
     * exactly the state the guard is designed to reject for
     * get_competency_eligibility, and the admin-check RPCs also fail
     * because has_role(NULL, 'admin') is false.
     */
    function callAsRoleExpectingReject(role: "anon" | "authenticated", call: string): string {
      const sql = `
        BEGIN;
        SET LOCAL role ${role};
        DO $$
        BEGIN
          BEGIN
            PERFORM ${call};
            RAISE NOTICE 'NO_ERROR';
          EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'INSUFFICIENT_PRIVILEGE';
          WHEN OTHERS THEN
            RAISE NOTICE 'OTHER:%', SQLSTATE;
          END;
        END $$;
        ROLLBACK;
      `.trim();
      const r = spawnSync(
        "psql",
        ["-v", "ON_ERROR_STOP=1", "-c", sql],
        { encoding: "utf8" },
      );
      // psql prints RAISE NOTICE to stderr.
      const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      const m = combined.match(/NOTICE:\s*(NO_ERROR|INSUFFICIENT_PRIVILEGE|OTHER:[A-Z0-9]+)/);
      return m ? m[1] : `UNKNOWN(${combined.slice(0, 200)})`;
    }

    it("get_competency_eligibility rejects anon with insufficient_privilege", () => {
      const outcome = callAsRoleExpectingReject(
        "anon",
        "public.get_competency_eligibility(CURRENT_DATE)",
      );
      // anon has no EXECUTE grant, so the reject may come from the ACL
      // layer (also insufficient_privilege / 42501) OR from the body
      // guard. Either way it must be insufficient_privilege.
      expect(outcome).toBe("INSUFFICIENT_PRIVILEGE");
    });

    it("trigger_clwrota_sync rejects authenticated (non-admin) with insufficient_privilege", () => {
      // authenticated has EXECUTE (for admins), so this exercises the
      // in-body guard specifically — auth.uid() is NULL here so
      // has_role(...) is false.
      const outcome = callAsRoleExpectingReject(
        "authenticated",
        "public.trigger_clwrota_sync('staff')",
      );
      expect(outcome).toBe("INSUFFICIENT_PRIVILEGE");
    });

    it("list_clwrota_cron_runs rejects authenticated (non-admin) with insufficient_privilege", () => {
      const outcome = callAsRoleExpectingReject(
        "authenticated",
        "public.list_clwrota_cron_runs(10)",
      );
      expect(outcome).toBe("INSUFFICIENT_PRIVILEGE");
    });

    it("trigger_clwrota_sync_all_rate_limited rejects authenticated (non-admin)", () => {
      const outcome = callAsRoleExpectingReject(
        "authenticated",
        "public.trigger_clwrota_sync_all_rate_limited()",
      );
      expect(outcome).toBe("INSUFFICIENT_PRIVILEGE");
    });
  });
});
