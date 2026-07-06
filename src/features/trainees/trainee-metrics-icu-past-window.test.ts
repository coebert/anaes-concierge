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

function codes(m: ReturnType<typeof metricsFor>): string[] {
  return m.warnings.map((w) => w.code);
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
    expect(codes(m)).toContain("no_theatre_rows_non_theatre_block");
    // The misleading import-failure code must NOT appear here — that's the
    // whole point of the fix.
    expect(codes(m)).not.toContain("no_theatre_session_rows");

    const note = m.warnings.find((w) => w.code === "no_theatre_rows_non_theatre_block")!;
    expect(note.level).toBe("info");
    expect(note.message).not.toMatch(/no theatre rows imported/i);
    expect(note.message).toMatch(/icu|on-call/i);
  });

  it("recognises icu_ct2_plus as a clinical non-theatre duty", () => {
    const m = metricsFor([
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-04-20" },
    ]);
    expect(codes(m)).toContain("no_theatre_rows_non_theatre_block");
    expect(codes(m)).not.toContain("no_theatre_session_rows");
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
    expect(codes(m)).toContain("no_theatre_rows_non_theatre_block");
    expect(codes(m)).not.toContain("no_theatre_session_rows");
  });

  it("handles a mixed ICU + on-call past window (the real-world case)", () => {
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
    // ICU rolls up to shift-days. The fixture's `(i % 28) + 1` produces
    // 28 distinct dates across i=0..29 (days 1 and 2 repeat), so 28 ICU
    // shifts + 10 evening on-calls = 38.
    expect(m.onCallLists).toBe(38);
    expect(m.icuLists).toBe(28);

    expect(codes(m)).toContain("no_theatre_rows_non_theatre_block");
    expect(codes(m)).not.toContain("no_theatre_session_rows");

  });

  it("keeps the original 'no theatre rows imported' warning when the past window has no clinical work at all", () => {
    // No theatre rows AND no ICU/on-call/obstetrics rows — only SPA / teaching.
    // This is the original data-quality signal and must still fire.
    const m = metricsFor([
      { role_on_list: "solo", session: "am", duty_type: "spa",
        theatre_session_id: null, session_date: "2026-04-10" },
      { role_on_list: "solo", session: "pm", duty_type: "teaching",
        theatre_session_id: null, session_date: "2026-04-11" },
    ]);
    expect(codes(m)).toContain("no_theatre_session_rows");
    expect(codes(m)).not.toContain("no_theatre_rows_non_theatre_block");
    const note = m.warnings.find((w) => w.code === "no_theatre_session_rows")!;
    expect(note.message).toMatch(/no theatre rows imported/i);
  });

  it("keeps the original warning when the trainee has zero assignments at all", () => {
    const m = metricsFor([]);
    expect(codes(m)).toContain("no_theatre_session_rows");
    expect(codes(m)).not.toContain("no_theatre_rows_non_theatre_block");
  });

  it("does not downgrade the warning when matched theatre rows exist alongside ICU work", () => {
    // 6 matched theatre lists + an ICU day → happy path, no missing-rows
    // warning of either flavour.
    const a: MetricAssignment[] = [];
    for (let i = 0; i < 6; i++) {
      a.push({ role_on_list: "supervised", session: "am", duty_type: "theatre",
        theatre_session_id: `ts-${i}`, session_date: `2026-05-${String(i + 1).padStart(2, "0")}` });
    }
    a.push({ role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
      theatre_session_id: null, session_date: "2026-05-20" });

    const m = metricsFor(a);
    expect(m.daytimeLists).toBe(6);
    expect(codes(m)).not.toContain("no_theatre_session_rows");
    expect(codes(m)).not.toContain("no_theatre_rows_non_theatre_block");
  });

  it("still surfaces the unmatched-ratio warning when most theatre rows fail to match — alarm wins over the ICU note", () => {
    // 1 matched + 4 unmatched theatre rows = 80% unmatched → high_unmatched_ratio.
    // An incidental ICU day on the side must not flip the warning to the new
    // (gentler) code, because this trainee really does have a theatre data
    // problem.
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
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-05-06" },
    ];
    const m = metricsFor(a);
    expect(codes(m)).toContain("high_unmatched_ratio");
    expect(codes(m)).not.toContain("no_theatre_rows_non_theatre_block");
  });
});
