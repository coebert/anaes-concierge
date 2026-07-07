import { describe, it, expect } from "vitest";
import {
  classifyRequirement,
  monthsBetween,
  summariseTraineeReadiness,
  type ArcpProgress,
  type ArcpRequirement,
} from "./arcp";

const req = (
  id: string,
  target: number,
  overrides: Partial<ArcpRequirement> = {},
): ArcpRequirement => ({
  id, training_level: "CT1", code: id, label: id, category: "assessment",
  target_value: target, unit: "count", sort_order: 100, active: true,
  ...overrides,
});

const prog = (
  requirement_id: string,
  current: number,
  arcp_date: string | null = null,
): ArcpProgress => ({
  id: `p-${requirement_id}`, trainee_id: "t1", requirement_id,
  current_value: current, arcp_date, notes: null,
});

describe("monthsBetween", () => {
  it("returns positive months forward", () => {
    expect(monthsBetween("2026-01-01", "2026-07-01")).toBeCloseTo(6, 0);
  });
  it("returns negative when target is in the past", () => {
    expect(monthsBetween("2026-07-01", "2026-01-01")).toBeLessThan(0);
  });
});

describe("classifyRequirement", () => {
  it("complete when current ≥ target", () => {
    const r = classifyRequirement({
      requirement: req("wbas", 40), progress: prog("wbas", 45, "2026-08-01"),
      today: "2026-07-01",
    });
    expect(r.status).toBe("complete");
    expect(r.shortfall).toBe(0);
  });

  it("behind when close to ARCP and far short", () => {
    const r = classifyRequirement({
      requirement: req("wbas", 40), progress: prog("wbas", 10, "2026-07-15"),
      today: "2026-07-01",
    });
    expect(r.status).toBe("behind");
  });

  it("on_track early in the year with matching pace", () => {
    // 3 months in of 12 → expect ~25%. Actual 30% → on_track.
    const r = classifyRequirement({
      requirement: req("cases", 300), progress: prog("cases", 90, "2027-04-01"),
      today: "2026-10-01",
    });
    expect(r.status).toBe("on_track");
  });

  it("at_risk when pace lagging but window remains", () => {
    // 9 months in of 12 → expect ~75%. Actual 50%.
    const r = classifyRequirement({
      requirement: req("cases", 300), progress: prog("cases", 150, "2026-10-01"),
      today: "2026-07-01",
    });
    expect(r.status).toBe("at_risk");
  });

  it("target zero → unknown status", () => {
    const r = classifyRequirement({
      requirement: req("todo", 0), progress: null, today: "2026-07-01",
    });
    expect(r.status).toBe("unknown");
  });

  it("no progress row treated as zero", () => {
    const r = classifyRequirement({
      requirement: req("iac", 1), progress: null, today: "2026-07-01",
      fallbackArcpDate: "2026-07-15",
    });
    expect(r.status).toBe("behind");
    expect(r.current).toBe(0);
    expect(r.shortfall).toBe(1);
  });
});

describe("summariseTraineeReadiness", () => {
  const requirements: ArcpRequirement[] = [
    req("wbas", 40),
    req("mtr", 3),
    req("cases", 300),
    req("other", 1, { training_level: "ST3" }), // filtered out
  ];

  it("computes % complete and worst status", () => {
    const summary = summariseTraineeReadiness({
      traineeId: "t1",
      trainingLevel: "CT1",
      requirements,
      progress: [
        prog("wbas", 40, "2026-08-01"),
        prog("mtr", 1, "2026-08-01"),
        prog("cases", 50, "2026-08-01"),
      ],
      today: "2026-07-01",
    });
    // total target 343, current capped: 40 + 1 + 50 = 91 → 91/343 ≈ 27%
    expect(summary.percentComplete).toBe(27);
    // MTR & cases are behind (ARCP in ~1 month, ratio very low) → worst = behind
    expect(summary.worstStatus).toBe("behind");
    expect(summary.behindCount).toBeGreaterThanOrEqual(1);
    expect(summary.items.some((i) => i.requirement.id === "other")).toBe(false);
  });

  it("empty when no requirements match training level", () => {
    const summary = summariseTraineeReadiness({
      traineeId: "t1",
      trainingLevel: "ST99",
      requirements,
      progress: [],
      today: "2026-07-01",
    });
    expect(summary.items).toHaveLength(0);
    expect(summary.percentComplete).toBe(0);
    expect(summary.worstStatus).toBe("unknown");
  });
});
