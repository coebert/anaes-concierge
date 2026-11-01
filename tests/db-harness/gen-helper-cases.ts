/**
 * Emits SQL harness cases from the REAL leave-status helper patch builder, so
 * the DB guard is exercised with the exact UPDATE body the UI sends.
 * Usage: bun tests/db-harness/gen-helper-cases.ts > cases-helper.sql
 */
import { buildLeaveStatusPatch } from "../../src/features/leave/optimistic-cancel-leave";

const lit = (v: unknown) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const setClause = (p: Record<string, unknown>) =>
  Object.entries(p)
    .map(([k, v]) => `${k}=${lit(v)}`)
    .join(", ");
const S = "'00000000-0000-0000-0000-000000000051'";
const C = "'00000000-0000-0000-0000-00000000000c'";
const PENDING = "10000000-0000-0000-0000-000000000001";
const S_APPROVED = "10000000-0000-0000-0000-000000000002";
const C_APPROVED = "10000000-0000-0000-0000-000000000003";

const out: string[] = [];
const kase = (name: string, uid: string, sql: string, expect: "allowed" | "denied") =>
  out.push(`SELECT t(${lit(name)}, ${uid}, $q$${sql}$q$, '${expect}');`);
const upd = (id: string, p: Record<string, unknown>) =>
  `UPDATE leave_requests SET ${setClause(p)} WHERE id='${id}'`;
const keepsDecision = (id: string) =>
  `SELECT assert_true((SELECT status='cancelled' AND decided_at IS NOT DISTINCT FROM (SELECT decided_at FROM leave_requests_snapshot WHERE id='${id}') AND decided_by IS NOT DISTINCT FROM (SELECT decided_by FROM leave_requests_snapshot WHERE id='${id}') FROM leave_requests WHERE id='${id}'), 'decision metadata preserved')`;

const cancel = buildLeaveStatusPatch("cancelled", {
  decided_at: "2030-01-01T00:00:00Z",
  decided_by: "00000000-0000-0000-0000-00000000000a",
});
kase(
  "helper cancel: staff cancels own pending (exact UI payload)",
  S,
  `${upd(PENDING, cancel)}; ${keepsDecision(PENDING)}`,
  "allowed",
);
// Live RLS: ordinary staff may only update their own PENDING rows, so this is a 0-row no-op the helper reports as failure.
kase(
  "helper cancel: ordinary staff on own APPROVED is a 0-row no-op (helper fails + rolls back)",
  S,
  `${upd(S_APPROVED, cancel)}; ${keepsDecision(S_APPROVED)}`,
  "denied",
);
kase(
  "legacy helper payload rejected for self-coordinator too",
  C,
  upd(C_APPROVED, { status: "cancelled", decided_at: "2030-01-01T00:00:00Z" }),
  "denied",
);
kase(
  "helper cancel: self-coordinator cancels own approved (exact UI payload)",
  C,
  `${upd(C_APPROVED, cancel)}; ${keepsDecision(C_APPROVED)}`,
  "allowed",
);
kase(
  "legacy helper payload (status+decided_at) rejected by owner guard",
  S,
  upd(PENDING, { status: "cancelled", decided_at: "2030-01-01T00:00:00Z" }),
  "denied",
);
// Failed path the helper must roll back: a staff member cannot cancel someone else's leave (RLS => 0 rows).
kase(
  "helper cancel: staff on another's leave updates 0 rows (helper treats as failure)",
  S,
  `${upd(C_APPROVED, cancel)}; SELECT assert_true((SELECT status FROM leave_requests WHERE id='${C_APPROVED}')='cancelled','changed')`,
  "denied",
);
for (const st of ["approved", "rejected"] as const) {
  const p = buildLeaveStatusPatch(st, {
    decided_by: "00000000-0000-0000-0000-00000000000a",
    decided_at: "1999-01-01T00:00:00Z",
    decision_notes: "ok",
  });
  kase(
    `helper ${st}: coordinator decides staff leave, actor/time server-stamped`,
    C,
    `${upd(PENDING, p)}; SELECT assert_true((SELECT status='${st}' AND decided_by=${C}::uuid AND decided_at > now() - interval '1 minute' FROM leave_requests WHERE id='${PENDING}'),'server actor')`,
    "allowed",
  );
  kase(`helper ${st}: staff cannot self-decide with helper payload`, S, upd(PENDING, p), "denied");
}
console.log(
  "CREATE TEMP TABLE IF NOT EXISTS leave_requests_snapshot AS SELECT id, decided_at, decided_by FROM leave_requests;",
);
console.log("GRANT SELECT ON leave_requests_snapshot TO authenticated, service_role;");
console.log(out.join("\n"));
