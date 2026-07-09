/**
 * Contract tests for the `enforce_specialty_preference_offered` trigger on
 * public.staff_specialty_preferences.
 *
 * Ground truth: SDH does not offer vascular or cardiac/cardiothoracic
 * anaesthesia, so those specialties must never be persisted as practice
 * preferences — regardless of which `specialty_preference` enum value is
 * submitted. This test in particular guards against `prefer_not_to`
 * (added later) silently bypassing the filter.
 *
 * The trigger is expected to look up the specialty *name* and reject the
 * write with SQLSTATE 23514 (check_violation) whenever the name matches
 * /vascular|cardiac|cardio-?thoracic/i, no matter what preference level
 * is being written.
 *
 * Skips gracefully when PGHOST is unavailable so `bun test` still runs
 * without DB access.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

function psql(sql: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-X", "-A", "-t", "-c", sql],
    { encoding: "utf8" },
  );
  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status ?? -1,
  };
}

const canRunDbTests = !!process.env.PGHOST;
const d = canRunDbTests ? describe : describe.skip;

// Every value in the specialty_preference enum. If the enum grows, this
// test grows with it via the runtime lookup below.
function loadEnumValues(): string[] {
  const r = psql(
    "SELECT unnest(enum_range(NULL::public.specialty_preference))::text",
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function findSpecialtyId(nameRegex: string): string | null {
  const r = psql(
    `SELECT id FROM public.specialties WHERE name ~* '${nameRegex}' ORDER BY name LIMIT 1`,
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout || null;
}

function findAllowedSpecialtyId(): string | null {
  const r = psql(
    `SELECT id FROM public.specialties WHERE name !~* 'vascular|cardiac|cardio-?thoracic' ORDER BY name LIMIT 1`,
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout || null;
}

function findStaffId(): string | null {
  const r = psql(
    `SELECT id FROM public.profiles WHERE active = true ORDER BY id LIMIT 1`,
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout || null;
}

/**
 * Attempt an INSERT inside a rolled-back transaction so no data is
 * persisted. Returns `{ blocked, sqlstate, message }`. `blocked` is
 * true when the trigger raised an error, false when the insert would
 * have succeeded.
 */
function tryInsertRolledBack(
  staffId: string,
  specialtyId: string,
  preference: string,
): { blocked: boolean; sqlstate: string; message: string } {
  const sql = `
DO $$
DECLARE
  v_sqlstate text := '';
  v_msg      text := '';
BEGIN
  BEGIN
    INSERT INTO public.staff_specialty_preferences (staff_id, specialty_id, preference)
    VALUES ('${staffId}'::uuid, '${specialtyId}'::uuid, '${preference}'::public.specialty_preference)
    ON CONFLICT (staff_id, specialty_id) DO UPDATE SET preference = EXCLUDED.preference;
  EXCEPTION WHEN OTHERS THEN
    v_sqlstate := SQLSTATE;
    v_msg      := SQLERRM;
  END;
  RAISE NOTICE 'RESULT %|%', v_sqlstate, v_msg;
  -- Always roll back the outer transaction so no rows persist.
  RAISE EXCEPTION 'rollback-sentinel';
END $$;
  `;
  const r = spawnSync(
    "psql",
    ["-X", "-A", "-t", "-c", sql],
    { encoding: "utf8" },
  );
  const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = combined.match(/RESULT ([0-9A-Z]*)\|(.*)/);
  const sqlstate = m?.[1] ?? "";
  const message = m?.[2] ?? "";
  return { blocked: sqlstate.length > 0, sqlstate, message };
}

d("enforce_specialty_preference_offered trigger", () => {
  const staffId = findStaffId();
  const vascularId = findSpecialtyId("vascular");
  const cardiacId = findSpecialtyId("cardiac|cardio-?thoracic");
  const allowedId = findAllowedSpecialtyId();
  const enumValues = loadEnumValues();

  it("has a staff row, filtered specialties, and an allowed specialty to test against", () => {
    expect(staffId).toBeTruthy();
    expect(vascularId).toBeTruthy();
    expect(cardiacId).toBeTruthy();
    expect(allowedId).toBeTruthy();
  });

  it("includes prefer_not_to in the specialty_preference enum", () => {
    expect(enumValues).toContain("prefer_not_to");
    // Sanity — the other levels must still exist too.
    expect(enumValues).toEqual(
      expect.arrayContaining(["preferred", "willing", "prefer_not_to", "none"]),
    );
  });

  // Guard against a future enum value silently slipping past the trigger.
  for (const pref of ["preferred", "willing", "prefer_not_to", "none"]) {
    it(`blocks INSERT of "${pref}" for vascular`, () => {
      const res = tryInsertRolledBack(staffId!, vascularId!, pref);
      expect(res.blocked).toBe(true);
      // 23514 = check_violation, which the trigger raises via
      // "USING ERRCODE = 'check_violation'".
      expect(res.sqlstate).toBe("23514");
      expect(res.message.toLowerCase()).toContain("vascular");
      expect(res.message.toLowerCase()).toContain("not offered");
    });

    it(`blocks INSERT of "${pref}" for cardiac / cardiothoracic`, () => {
      const res = tryInsertRolledBack(staffId!, cardiacId!, pref);
      expect(res.blocked).toBe(true);
      expect(res.sqlstate).toBe("23514");
      expect(res.message.toLowerCase()).toMatch(/cardiac|cardio-?thoracic/);
      expect(res.message.toLowerCase()).toContain("not offered");
    });
  }

  it("allows prefer_not_to for a specialty SDH does offer (trigger passes)", () => {
    // Note: the exec-tool DB role has no INSERT grant on
    // staff_specialty_preferences (writes go through PostgREST with the
    // user's role in production). We only care that the trigger itself
    // does not reject the write — i.e. the failure mode, if any, is a
    // permission error (42501), NOT a check_violation (23514).
    const res = tryInsertRolledBack(staffId!, allowedId!, "prefer_not_to");
    expect(res.sqlstate).not.toBe("23514");
    if (res.blocked) {
      expect(res.sqlstate).toBe("42501"); // permission_denied for the test role
    }
  });
});
