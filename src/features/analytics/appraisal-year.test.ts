import { describe, expect, it } from "vitest";
import {
  appraisalYearLabel,
  appraisalYearMonths,
  appraisalYearOf,
  appraisalYearRange,
  buildAppraisalYear,
} from "./appraisal-year";
import type { SpecialtyPaRules, SpecialtyRow } from "./specialty-workload";

const rules: SpecialtyPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

const row = (r: Partial<SpecialtyRow>): SpecialtyRow => ({
  staff_id: "doc",
  session_date: "2025-06-02",
  session: "am",
  duty_type: "theatre",
  extra_type: null,
  ...r,
});

describe("appraisal year helpers", () => {
  it("runs April to March", () => {
    expect(appraisalYearOf("2026-03-31")).toBe(2025);
    expect(appraisalYearOf("2026-04-01")).toBe(2026);
    expect(appraisalYearRange(2025)).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(appraisalYearLabel(2025)).toBe("2025/26");
    expect(appraisalYearMonths(2025)[0]).toBe("2025-04");
    expect(appraisalYearMonths(2025)).toHaveLength(12);
    expect(appraisalYearMonths(2025)[11]).toBe("2026-03");
  });
});

describe("buildAppraisalYear", () => {
  it("separates intensive care from other clinical work", () => {
    const s = buildAppraisalYear(
      "doc",
      2025,
      [
        row({ duty_type: "icu_consultant_oncall", session: "night" }),
        row({ session_date: "2025-06-03", duty_type: "icu_ct2_plus" }),
        row({ session_date: "2025-06-04", specialty_name: "ENT" }),
      ],
      rules,
    );
    expect(s.icu.onCalls).toBe(1);
    expect(s.icu.sessions).toBe(1);
    expect(s.other.sessions).toBe(1);
    expect(s.overall.totalPas).toBe(
      Math.round((s.icu.totalPas + s.other.totalPas) * 100) / 100,
    );
  });

  it("ignores work outside the appraisal year and other doctors", () => {
    const s = buildAppraisalYear(
      "doc",
      2025,
      [
        row({ session_date: "2025-03-31" }),
        row({ session_date: "2026-04-01" }),
        row({ staff_id: "other", session_date: "2025-06-05" }),
      ],
      rules,
    );
    expect(s.overall.sessions).toBe(0);
  });

  it("reports months with no activity as a gap", () => {
    const s = buildAppraisalYear("doc", 2025, [row({ specialty_name: "ENT" })], rules);
    const gap = s.gaps.find((g) => g.kind === "no-activity-month")!;
    expect(gap.label).toContain("11 months");
    expect(s.months.find((m) => m.month === "2025-06")!.sessions).toBe(1);
  });

  it("flags sessions with no CLWRota PA value", () => {
    const s = buildAppraisalYear(
      "doc",
      2025,
      [row({ specialty_name: "ENT" }), row({ session_date: "2025-06-03", pa_credit: 1 })],
      rules,
    );
    const gap = s.gaps.find((g) => g.kind === "unrecorded-pas")!;
    expect(gap.label).toContain("1 session");
  });

  it("flags a doctor with no intensive care work", () => {
    const s = buildAppraisalYear("doc", 2025, [row({ specialty_name: "ENT" })], rules);
    expect(s.gaps.some((g) => g.kind === "no-icu")).toBe(true);
  });

  it("credits work where the doctor is a named attending consultant", () => {
    const s = buildAppraisalYear(
      "doc",
      2025,
      [row({ staff_id: "other", attending_consultant_ids: ["other", "doc"] })],
      rules,
    );
    expect(s.overall.sessions).toBe(1);
    expect(s.months.find((m) => m.month === "2025-06")!.rows).toBe(1);
  });
});
