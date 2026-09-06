import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  tallyIcuWorkload,
  type IcuRow,
} from "@/features/analytics/icu-workload";

const base: IcuRow = {
  staff_id: "a",
  session_date: "2026-03-02", // Monday
  session: "am",
  duty_type: "icu_consultant_oncall",
  extra_type: null,
};

describe("tallyIcuWorkload — attending consultants & recorded PAs", () => {
  it("credits every attending consultant listed on a row", () => {
    const rows: IcuRow[] = [
      { ...base, attending_consultant_ids: ["a", "b"] },
      { ...base, session: "pm", attending_consultant_ids: ["a", "b"] },
    ];
    const out = tallyIcuWorkload(rows, DEFAULT_RULES);
    const a = out.find((t) => t.staff_id === "a");
    const b = out.find((t) => t.staff_id === "b");
    expect(a?.sessions).toBe(2);
    expect(b?.sessions).toBe(2);
    expect(b?.totalPas).toBe(a?.totalPas);
  });

  it("falls back to staff_id when no attendee list is stored", () => {
    const out = tallyIcuWorkload([{ ...base, attending_consultant_ids: [] }], DEFAULT_RULES);
    expect(out).toHaveLength(1);
    expect(out[0].staff_id).toBe("a");
  });

  it("uses the CLWRota-recorded PA value instead of rule estimates", () => {
    const out = tallyIcuWorkload([{ ...base, pa_credit: 1.5 }], DEFAULT_RULES);
    expect(out[0].totalPas).toBeCloseTo(1.5, 5);
    expect(out[0].clwrotaPas).toBeCloseTo(1.5, 5);
    expect(out[0].estimatedPas).toBeCloseTo(0, 5);
    // Day/session counts still reflect the activity.
    expect(out[0].days).toBe(1);
    expect(out[0].sessions).toBe(1);
  });

  it("does not double-count the weekend credit on a stored-PA weekend row", () => {
    const out = tallyIcuWorkload(
      [{ ...base, session_date: "2026-03-07", pa_credit: 1 }], // Saturday
      DEFAULT_RULES,
    );
    expect(out[0].weekendDays).toBe(1);
    expect(out[0].totalPas).toBeCloseTo(1, 5); // stored PA only — no extra weekend credit
  });

  it("mixes stored and estimated PAs across rows", () => {
    const rows: IcuRow[] = [
      { ...base, pa_credit: 0.5 },
      { ...base, session_date: "2026-03-03" }, // unstored → 1 session / 1 per PA
    ];
    const out = tallyIcuWorkload(rows, DEFAULT_RULES);
    expect(out[0].totalPas).toBeCloseTo(1.5, 5);
    expect(out[0].clwrotaPas).toBeCloseTo(0.5, 5);
    expect(out[0].estimatedPas).toBeCloseTo(1.0, 5);
  });

  it("counts stored PAs on extra rows toward extra PAs, not planned", () => {
    const out = tallyIcuWorkload(
      [{ ...base, extra_type: "locum", pa_credit: 1 }],
      DEFAULT_RULES,
    );
    expect(out[0].extraPas).toBeCloseTo(1, 5);
    expect(out[0].plannedPas).toBeCloseTo(0, 5);
  });
});
