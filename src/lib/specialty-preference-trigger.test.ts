/**
 * Contract tests for the `enforce_specialty_preference_offered` trigger
 * on public.staff_specialty_preferences.
 *
 * Ground truth: SDH does not offer vascular or cardiac / cardiothoracic
 * anaesthesia, so those specialties must never be persisted as practice
 * preferences — regardless of which `specialty_preference` enum value is
 * submitted. This test in particular guards against the `prefer_not_to`
 * level (added later) silently bypassing the filter.
 *
 * The exec-tool DB role has no INSERT grant on staff_specialty_preferences
 * (writes go through PostgREST with the user's role in production), so
 * live INSERTs would fail with 42501 permission_denied *before* the row
 * trigger fires. Instead, this suite asserts the shape of the guarantee
 * at the schema level:
 *   1. `prefer_not_to` is a real enum value.
 *   2. The trigger is installed for INSERT AND UPDATE on the table.
 *   3. The trigger's function body checks the specialty *name* against
 *      /vascular|cardiac|cardio-?thoracic/i and raises a check_violation
 *      — with no branching on the `preference` value, so no future enum
 *      addition (like `prefer_not_to`) can bypass it.
 *   4. No live rows in staff_specialty_preferences reference a filtered
 *      specialty (belt-and-braces data check).
 *
 * Skips gracefully when PGHOST is unavailable so `bun test` still runs
 * without DB access.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

function psql(sql: string): string {
  const r = spawnSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-X", "-A", "-t", "-c", sql],
    { encoding: "utf8" },
  );
  if ((r.status ?? -1) !== 0) {
    throw new Error(r.stderr || `psql exited with status ${r.status}`);
  }
  return (r.stdout ?? "").trim();
}

const canRunDbTests = !!process.env.PGHOST;
const d = canRunDbTests ? describe : describe.skip;

d("enforce_specialty_preference_offered trigger — schema contract", () => {
  it("exposes prefer_not_to (and the other levels) on the specialty_preference enum", () => {
    const values = psql(
      "SELECT unnest(enum_range(NULL::public.specialty_preference))::text",
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(values).toEqual(
      expect.arrayContaining(["preferred", "willing", "prefer_not_to", "none"]),
    );
  });

  it("has the enforcement trigger installed for INSERT AND UPDATE", () => {
    const rows = psql(`
      SELECT tgname || '|' ||
             CASE WHEN (tgtype & 4) <> 0 THEN 'INSERT' ELSE '' END || ',' ||
             CASE WHEN (tgtype & 16) <> 0 THEN 'UPDATE' ELSE '' END
        FROM pg_trigger
       WHERE tgrelid = 'public.staff_specialty_preferences'::regclass
         AND NOT tgisinternal
         AND tgfoid = 'public.enforce_specialty_preference_offered'::regproc
    `);
    // Exactly one row, and both INSERT + UPDATE are covered by the trigger's
    // event mask. If someone re-creates it as INSERT-only, this fails.
    const lines = rows.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("INSERT");
    expect(lines[0]).toContain("UPDATE");
  });

  it("checks the specialty NAME (not the preference value), so no enum value can bypass it", () => {
    const body = psql(
      `SELECT prosrc FROM pg_proc
        WHERE oid = 'public.enforce_specialty_preference_offered'::regproc`,
    );
    // Must look up the specialty name from public.specialties.
    expect(body).toMatch(/from\s+public\.specialties/i);
    // Must reject on the vascular / cardiac / cardiothoracic pattern.
    expect(body).toMatch(/vascular/i);
    expect(body).toMatch(/cardiac/i);
    expect(body).toMatch(/cardio-?thoracic/i);
    // Must raise check_violation, not just NOTICE / WARNING.
    expect(body).toMatch(/check_violation/i);
    // Guardrail: the function body must NOT branch on the preference
    // value (NEW.preference). Any such branch would risk letting a
    // specific enum value — including prefer_not_to — slip past.
    expect(body).not.toMatch(/NEW\.preference/);
  });

  it("has no persisted rows referencing a filtered-out specialty", () => {
    const count = psql(`
      SELECT COUNT(*)::text
        FROM public.staff_specialty_preferences p
        JOIN public.specialties s ON s.id = p.specialty_id
       WHERE s.name ~* '(vascular|cardiac|cardio-?thoracic)'
    `);
    expect(count).toBe("0");
  });

  it("actually has vascular and cardiac rows in the specialties catalogue (so the check is meaningful)", () => {
    const count = psql(`
      SELECT COUNT(*)::text FROM public.specialties
       WHERE name ~* '(vascular|cardiac|cardio-?thoracic)'
    `);
    // If this ever drops to 0 the trigger becomes untestable — either
    // the catalogue was pruned (in which case the trigger is redundant
    // and should be revisited) or seed data drifted.
    expect(Number(count)).toBeGreaterThan(0);
  });
});
