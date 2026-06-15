import { describe, it, expect } from "vitest";
import { computeTraineeMetrics, type MetricAssignment } from "./trainee-metrics";

/**
 * Regression coverage for the bug where trainees whose past window was
 * entirely ICU / on-call / obstetrics (but who have future theatre work
 * scheduled) were incorrectly shown the data-quality alarm
 * "No theatre rows imported for this trainee."
 *
 * The card is computed with `suppressTheatreWarnings = false` for these
 * trainees because `isIcuBlockOnly` only inspects the *future* window —
 * future theatre work disqualifies them as ICU-block-only. The fix
 * lives inside `computeTraineeMetrics`: when the past window has zero
 * theatre rows but contains clinical non-theatre duties (ICU, on-call,
 * obstetrics), emit the softer informational note instead of the
 * import-failure alarm.
 *
 * The five real-world trainees that triggered this bug all had only
 * `icu_trainee`, `icu_ct2_plus`, `registrar_oncall`, or `sho_oncall`
 * rows in their past window — those duty types must all be recognised
 * as clinical-but-not-theatre.
 */

const NOW = new Date("2026-06-15").getTime();
const START = "2026-02-01";

function metricsFor(assignments: MetricAssignment[]) {
  return computeTraineeMetrics(
    assignments,
    START,
    new Map(),
    new Map(),
    NOW,
    null,
    false, // suppressTheatreWarnings — trainee is NOT classified as ICU-only.
  );
}

describe("trainee metrics — ICU/on-call-only past window with future theatre work", () => {
  it("emits the ICU/on-call info note (not the import-failure warning) when the past window is icu_trainee only", () => {
    const m = metricsFor([
      { role_on_list: "solo", session: "am", duty_type: "icu_trainee",
        theatre_session_id: null, session_date: "2026-05-01" },
      { role_on_list: "solo", session: "pm", duty_type: "icu_trainee",
        theatre_session_id: null, session_date: "2026-05-01" },
    ]);

    expect(m.daytimeLists).toBe(0);
    expect(m.unmatchedTheatreRows).toBe(0);
    expect(m.warnings).toHaveLength(1);
    expect(m.warnings[0].code).toBe("no_theatre_rows_non_theatre_block");
    expect(m.warnings[0].level).toBe("info");
    // The misleading wording must not be used in this branch.
    expect(m.warnings[0].message).not.toMatch(/no theatre rows imported/i);
    expect(m.warnings[0].message).toMatch(/icu|on-call/i);
    // And the old code must not appear at all.
    expect(m.warnings.find((w) => w.code === "no_theatre_session_rows")).toBeUndefined();
  });

  it("recognises icu_ct2_plus as a clinical non-theatre duty", () => {
    const m = metricsFor([
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-04-20" },
    ]);
    expect(m.warnings.map((w) => w.code)).toEqual(["no_theatre_rows_non_theatre_block"]);
  });

  it.each([
    "registrar_oncall",
    "sho_oncall",
    "icu_consultant_oncall",
    "general_consultant_oncall",
    "consultant_in_charge",
    "obstetrics",
    "obstetrics_2nd",
  ])("recognises %s as a clinical non-theatre duty", (dutyType) => {
    const m = metricsFor([
      { role_on_list: "solo", session: "am", duty_type: dutyType,
        theatre_session_id: null, session_date: "2026-04-20" },
    ]);
    expect(m.warnings.map((w) => w.code)).toEqual(["no_theatre_rows_non_theatre_block"]);
  });

  it("works for a mixed ICU + on-call past window (the real-world case)", () => {
    // Mirrors Dr A Halsall: 30 ICU AM, 30 ICU PM, plus on-calls.
    const a: MetricAssignment[] = [];
    for (let i = 0; i < 30; i++) {
      const d = `2026-04-${String((i % 28) + 1).padStart(2, "0")}`;
      a.push({ role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: d });
      a.push({ role_on_list: "solo", session: "pm", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: d });
    }
    for (let i = 0; i < 10; i++) {
      a.push({ role_on_list: "solo", session: "eve", duty_type: "registrar_oncall",
        theatre_session_id: null, session_date: `2026-05-${String(i + 1).padStart(2, "0")}` });
    }

    const m = metricsFor(a);
    expect(m.totalAssignments).toBe(70);
    expect(m.daytimeLists).toBe(0);
    expect(m.unmatchedTheatreRows).toBe(0);
    // On-call counts must still register correctly.
    expect(m.onCallLists).toBe(70); // icu_ct2_plus + registrar_oncall both count as on-call
    expect(m.warnings.map((w) => w.code)).toEqual(["no_theatre_rows_non_theatre_block"]);
  });

  it("keeps the original 'no theatre rows imported' warning when the past window is genuinely empty of clinical work", () => {
    // No theatre rows AND no ICU/on-call rows — only SPA / teaching / admin.
    // This is the original data-quality signal and must still fire.
    const m = metricsFor([
      { role_on_list: "solo", session: "am", duty_type: "spa",
        theatre_session_id: null, session_date: "2026-04-10" },
      { role_on_list: "solo", session: "pm", duty_type: "teaching",
        theatre_session_id: null, session_date: "2026-04-11" },
    ]);
    expect(m.warnings.map((w) => w.code)).toEqual(["no_theatre_session_rows"]);
    expect(m.warnings[0].message).toMatch(/no theatre rows imported/i);
  });

  it("keeps the original warning when the trainee has zero assignments at all", () => {
    const m = metricsFor([]);
    expect(m.warnings.map((w) => w.code)).toEqual(["no_theatre_session_rows"]);
  });

  it("does NOT downgrade the warning when matched theatre rows exist alongside ICU work (different branch entirely)", () => {
    // Trainee has 6 matched theatre lists AND some ICU days. They should
    // get the normal happy-path metrics — no warning about missing rows.
    const a: MetricAssignment[] = [];
    for (let i = 0; i < 6; i++) {
      a.push({ role_on_list: "supervised", session: "am", duty_type: "theatre",
        theatre_session_id: `ts-${i}`, session_date: `2026-05-${String(i + 1).padStart(2, "0")}` });
    }
    a.push({ role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
      theatre_session_id: null, session_date: "2026-05-20" });

    const m = metricsFor(a);
    expect(m.daytimeLists).toBe(6);
    expect(m.warnings).toEqual([]); // happy path: no warning at all
  });

  it("still surfaces the unmatched-ratio warning when most theatre rows fail to match — alarm beats the ICU note", () => {
    // 1 matched + 4 unmatched theatre rows = 80% unmatched → high_unmatched_ratio.
    // This branch is independent of the new ICU note and must not regress.
    const a: MetricAssignment[] = [
      { role_on_list: "solo", session: "am", duty_type: "theatre",
        theatre_session_id: "ts-1", session_date: "2026-05-01" },
      { role_on_list: "solo", session: "am", duty_type: "theatre",
        theatre_session_id: null, session_date: "2026-05-02" },
      { role_on_list: "solo", session: "pm", duty_type: "theatre",
        theatre_session_id: null, session_date: "2026-05-03" },
      { role_on_list: "solo", session: "am", duty_type: "theatre",
        theatre_session_id: null, session_date: "2026-05-04" },
      { role_on_list: "solo", session: "pm", duty_type: "theatre",
        theatre_session_id: null, session_date: "2026-05-05" },
      // ICU day too — must not flip the warning to the new code.
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-05-06" },
    ];
    const m = metricsFor(a);
    expect(m.warnings.map((w) => w.code)).toContain("high_unmatched_ratio");
    expect(m.warnings.map((w) => w.code)).not.toContain("no_theatre_rows_non_theatre_block");
  });
});
