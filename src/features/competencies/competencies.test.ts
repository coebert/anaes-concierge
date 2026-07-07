import { describe, it, expect } from "vitest";
import {
  evaluateCompetency,
  isHoldingActive,
  roleMatchesRequirement,
  type Competency,
  type CompetencyRequirement,
  type StaffCompetency,
} from "./competencies";

const comp = (id: string, name: string): Competency => ({
  id, code: id, name, description: null, category: "subspecialty",
  applies_to_grades: ["consultant"], active: true, sort_order: 100,
});

const req = (
  specialty_id: string, competency_id: string,
  requirement: "required" | "recommended" = "required",
  applies_to_role: "solo" | "supervising" | "any" = "solo",
): CompetencyRequirement => ({
  id: `${specialty_id}-${competency_id}`, specialty_id, competency_id,
  requirement, applies_to_role,
});

const hold = (
  staff_id: string, competency_id: string,
  overrides: Partial<StaffCompetency> = {},
): StaffCompetency => ({
  id: `${staff_id}-${competency_id}`, staff_id, competency_id, level: null,
  granted_at: "2020-01-01", expires_at: null, revoked_at: null, notes: null,
  ...overrides,
});

describe("isHoldingActive", () => {
  it("respects granted_at, expires_at, revoked_at", () => {
    expect(isHoldingActive({ granted_at: "2024-01-01", expires_at: null, revoked_at: null }, "2024-06-01")).toBe(true);
    expect(isHoldingActive({ granted_at: "2024-07-01", expires_at: null, revoked_at: null }, "2024-06-01")).toBe(false);
    expect(isHoldingActive({ granted_at: "2020-01-01", expires_at: "2024-05-01", revoked_at: null }, "2024-06-01")).toBe(false);
    expect(isHoldingActive({ granted_at: "2020-01-01", expires_at: null, revoked_at: "2024-05-01" }, "2024-06-01")).toBe(false);
  });
});

describe("roleMatchesRequirement", () => {
  it("solo matches solo only; any matches everything", () => {
    expect(roleMatchesRequirement("solo", "solo")).toBe(true);
    expect(roleMatchesRequirement("supervising", "solo")).toBe(false);
    expect(roleMatchesRequirement("supervised", "any")).toBe(true);
  });
});

describe("evaluateCompetency", () => {
  const paeds = comp("paeds", "Paediatric anaesthesia");
  const cardiac = comp("cardiac", "Cardiac anaesthesia");
  const competencies = [paeds, cardiac];

  it("no specialty → no issues", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: null, role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds")], staffCompetencies: [], competencies,
    });
    expect(issues).toEqual([]);
  });

  it("missing required competency → error (blocking)", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds", "required")],
      staffCompetencies: [], competencies,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toMatch(/Paediatric/);
  });

  it("missing required with blockMissingRequired=false → warning", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds", "required")],
      staffCompetencies: [], competencies,
      blockMissingRequired: false,
    });
    expect(issues[0].severity).toBe("warning");
  });

  it("missing recommended competency → info", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds", "recommended")],
      staffCompetencies: [], competencies,
    });
    expect(issues[0].severity).toBe("info");
  });

  it("held competency → silent", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds")],
      staffCompetencies: [hold("s1", "paeds")],
      competencies,
    });
    expect(issues).toEqual([]);
  });

  it("only flags requirements for a matching role", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "supervising", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds", "required", "solo")],
      staffCompetencies: [], competencies,
    });
    expect(issues).toEqual([]);
  });

  it("expiring soon → info", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds")],
      staffCompetencies: [hold("s1", "paeds", { expires_at: "2025-06-15" })],
      competencies,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("info");
    expect(issues[0].message).toMatch(/expires in 14 days/);
  });

  it("supervised-only sign-off for solo role → error on required", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds")],
      staffCompetencies: [hold("s1", "paeds", { level: "supervised" })],
      competencies,
    });
    expect(issues.some((i) => i.severity === "error" && /supervised/.test(i.message))).toBe(true);
  });

  it("revoked holding is treated as missing (error)", () => {
    const issues = evaluateCompetency({
      staffId: "s1", specialtyId: "spec-paeds", role: "solo", onDate: "2025-06-01",
      requirements: [req("spec-paeds", "paeds")],
      staffCompetencies: [hold("s1", "paeds", { revoked_at: "2025-01-01" })],
      competencies,
    });
    expect(issues[0].severity).toBe("error");
  });
});
