/**
 * Assert that the four SECURITY DEFINER decryption RPCs are callable ONLY
 * by service_role — never by anon or authenticated. This locks in the
 * grant tightening from the earlier security migration and will fail if a
 * future migration re-opens EXECUTE to signed-in users.
 *
 * The test uses `psql` against the managed database via the standard
 * PG* environment variables. It skips (does not fail) when `PGHOST` is
 * absent so developers without DB access can still run `bun test`.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const RPCS = [
  "public.get_profiles_decrypted()",
  "public.get_profile_decrypted(uuid)",
  "public.get_access_requests_decrypted()",
  "public.get_leave_requests_decrypted()",
] as const;

const CLIENT_ROLES = ["anon", "authenticated"] as const;
const PRIVILEGED_ROLE = "service_role";

function psql(sql: string): string {
  const result = spawnSync(
    "psql",
    ["-tA", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout ?? "").trim();
}

const dbAvailable =
  !!process.env.PGHOST &&
  spawnSync("psql", ["-tA", "-c", "SELECT 1"], { encoding: "utf8" }).status === 0;

describe.skipIf(!dbAvailable)("decryption RPC grants", () => {
  it.each(RPCS)(
    "denies anon and authenticated EXECUTE on %s",
    (fn) => {
      for (const role of CLIENT_ROLES) {
        const out = psql(
          `SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE')`,
        );
        expect(
          out,
          `${role} unexpectedly has EXECUTE on ${fn}`,
        ).toBe("f");
      }
    },
  );

  it.each(RPCS)(
    "allows service_role EXECUTE on %s",
    (fn) => {
      const out = psql(
        `SELECT has_function_privilege('${PRIVILEGED_ROLE}', '${fn}', 'EXECUTE')`,
      );
      expect(
        out,
        `${PRIVILEGED_ROLE} is missing EXECUTE on ${fn}`,
      ).toBe("t");
    },
  );

  it("also denies PUBLIC on every decryption RPC", () => {
    for (const fn of RPCS) {
      // acl NULL means default privileges — Postgres grants EXECUTE to
      // PUBLIC when the pg_proc.proacl column is NULL, so we must also
      // verify the ACL has been explicitly set.
      const acl = psql(
        `SELECT COALESCE(proacl::text, '') FROM pg_proc
           WHERE oid = '${fn}'::regprocedure`,
      );
      expect(acl, `${fn} still has default (PUBLIC) EXECUTE grants`).not.toBe(
        "",
      );
      expect(
        acl.includes("=X/") || acl.includes("=/") ? true : false,
        `${fn} ACL should not grant EXECUTE to PUBLIC: ${acl}`,
      ).toBe(false);
    }
  });
});
