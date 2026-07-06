import { describe, it, expect } from "vitest";
import {
  classifyRisk,
  computeHalfDayCapacity,
  isSeniorTrainee,
  riskColor,
  riskLabel,
  type HalfDayInputs,
} from "./robustness";

const base: HalfDayInputs = {
  required: 0,
  consultantsAvailable: 0,
  seniorTraineesAvailable: 0,
  juniorTraineesAvailable: 0,
  sasAvailable: 0,
  consultantsOnSpa: 0,
  onLeave: 0,
  onOtherDuty: 0,
};

describe("classifyRisk", () => {
  it("returns ok when headroom comfortably positive", () => {
    expect(classifyRisk(2, 2)).toBe("ok");
    expect(classifyRisk(5, 5)).toBe("ok");
  });

  it("returns tight when headroom is 0 or 1 (RISK_TIGHT boundary)", () => {
    expect(classifyRisk(0, 0)).toBe("tight");
    expect(classifyRisk(1, 1)).toBe("tight");
  });

  it("returns shortfall when even SPA redeployment cannot cover", () => {
    expect(classifyRisk(-1, -1)).toBe("shortfall");
    expect(classifyRisk(-3, -2)).toBe("shortfall");
  });

  it("returns spa_required when SPA redeployment closes the gap", () => {
    expect(classifyRisk(-1, 0)).toBe("spa_required");
    expect(classifyRisk(-2, 1)).toBe("spa_required");
  });

  it("never reports spa_required when baseline headroom is already non-negative", () => {
    // headroomWithSpa is always >= headroom, but the branch order matters:
    // a non-negative headroom should never trip the spa_required check.
    expect(classifyRisk(0, 2)).toBe("tight");
    expect(classifyRisk(3, 5)).toBe("ok");
  });
});

describe("isSeniorTrainee", () => {
  it("classifies ST6/ST7/ST8 as senior", () => {
    expect(isSeniorTrainee("ST6")).toBe(true);
    expect(isSeniorTrainee("st7")).toBe(true);
    expect(isSeniorTrainee(" ST8 ")).toBe(true);
  });
  it("rejects junior and unknown levels", () => {
    for (const t of ["CT1", "CT2", "ST3", "ST4", "ST5", "ACCS1", "", null, undefined]) {
      expect(isSeniorTrainee(t)).toBe(false);
    }
  });
});

describe("computeHalfDayCapacity", () => {
  it("counts consultants + senior trainees as soloCapable; excludes SAS and juniors", () => {
    const cap = computeHalfDayCapacity({
      ...base,
      required: 3,
      consultantsAvailable: 2,
      seniorTraineesAvailable: 1,
      juniorTraineesAvailable: 4, // must not contribute to solo cover
      sasAvailable: 2,            // must not contribute to solo cover
    });
    expect(cap.soloCapable).toBe(3);
    expect(cap.headroom).toBe(0);
    expect(cap.risk).toBe("tight");
  });

  it("excludes consultants on SPA from baseline but counts them in headroomWithSpa", () => {
    const cap = computeHalfDayCapacity({
      ...base,
      required: 3,
      consultantsAvailable: 2,      // baseline short by 1
      consultantsOnSpa: 2,
    });
    expect(cap.soloCapable).toBe(2);
    expect(cap.headroom).toBe(-1);
    expect(cap.headroomWithSpa).toBe(1);
    expect(cap.risk).toBe("spa_required");
  });

  it("flags shortfall when SPA still cannot cover the gap", () => {
    const cap = computeHalfDayCapacity({
      ...base,
      required: 5,
      consultantsAvailable: 2,
      seniorTraineesAvailable: 0,
      consultantsOnSpa: 1, // still 2 short after redeploying SPA
    });
    expect(cap.headroom).toBe(-3);
    expect(cap.headroomWithSpa).toBe(-2);
    expect(cap.risk).toBe("shortfall");
  });

  it("reports ok when comfortably staffed", () => {
    const cap = computeHalfDayCapacity({
      ...base,
      required: 3,
      consultantsAvailable: 4,
      seniorTraineesAvailable: 2,
    });
    expect(cap.headroom).toBe(3);
    expect(cap.risk).toBe("ok");
  });

  it("passes onLeave / onOtherDuty / unfilled through unchanged", () => {
    const cap = computeHalfDayCapacity({
      ...base,
      required: 2,
      consultantsAvailable: 2,
      onLeave: 4,
      onOtherDuty: 1,
      unfilled: 0,
    });
    expect(cap.onLeave).toBe(4);
    expect(cap.onOtherDuty).toBe(1);
    expect(cap.unfilled).toBe(0);
  });

  it("clamps negative unfilled to zero", () => {
    const cap = computeHalfDayCapacity({ ...base, required: 2, consultantsAvailable: 2, unfilled: -3 });
    expect(cap.unfilled).toBe(0);
  });

  it("handles zero-required half-days (e.g. weekends, no lists)", () => {
    const cap = computeHalfDayCapacity({ ...base, required: 0, consultantsAvailable: 3 });
    expect(cap.headroom).toBe(3);
    expect(cap.risk).toBe("ok");
  });


  it("a half full of SAS and juniors with no consultants reports shortfall, not spa_required", () => {
    const cap = computeHalfDayCapacity({
      ...base,
      required: 2,
      sasAvailable: 5,
      juniorTraineesAvailable: 5,
    });
    expect(cap.soloCapable).toBe(0);
    expect(cap.headroomWithSpa).toBe(-2);
    expect(cap.risk).toBe("shortfall");
  });
});

describe("riskColor / riskLabel", () => {
  it("returns distinct labels per risk level", () => {
    const labels = (["ok", "tight", "spa_required", "shortfall"] as const).map(riskLabel);
    expect(new Set(labels).size).toBe(4);
    expect(riskLabel("spa_required")).toBe("SPA needed");
  });
  it("returns a non-empty class string for every risk level", () => {
    for (const r of ["ok", "tight", "spa_required", "shortfall"] as const) {
      expect(riskColor(r).length).toBeGreaterThan(0);
    }
  });
});
