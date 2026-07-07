import { describe, it, expect } from "vitest";
import { computeCompetencyMismatch } from "./mismatch";
import type { Competency, CompetencyRequirement, StaffCompetency } from "./competencies";

const comp = (id: string, name = id): Competency => ({
  id, code: id.toUpperCase(), name, description: null,
  category: "subspecialty", applies_to_grades: [], active: true, sort_order: 0,
});
const req = (
  specialty_id: string, competency_id: string,
  requirement: "required" | "recommended" = "required",
  applies_to_role: "solo" | "supervising" | "any" = "solo",
): CompetencyRequirement => ({
  id: `${specialty_id}-${competency_id}-${applies_to_role}`,
  specialty_id, competency_id, requirement, applies_to_role,
});
const hold = (
  staff_id: string, competency_id: string,
  overrides: Partial<StaffCompetency> = {},
): StaffCompetency => ({
  id: `${staff_id}-${competency_id}`, staff_id, competency_id, level: null,
  granted_at: "2020-01-01", expires_at: null, revoked_at: null, notes: null,
  ...overrides,
});

const base = {
  staffId: "s1",
  specialtyId: "spec",
  role: "solo",
  onDate: "2026-07-07",
  competencies: [comp("c1", "TOE"), comp("c2", "Paeds airway")],
};

describe("computeCompetencyMismatch", () => {
  it("marks missing required as blocking", () => {
    const out = computeCompetencyMismatch({
      ...base,
      requirements: [req("spec", "c1")],
      staffCompetencies: [],
    });
    expect(out.hasBlocker).toBe(true);
    expect(out.requiredMissing).toBe(1);
    expect(out.rows[0]).toMatchObject({ status: "missing", blocking: true });
  });

  it("marks supervised-only for solo as blocking", () => {
    const out = computeCompetencyMismatch({
      ...base,
      requirements: [req("spec", "c1", "required", "solo")],
      staffCompetencies: [hold("s1", "c1", { level: "supervised" })],
    });
    expect(out.hasBlocker).toBe(true);
    expect(out.rows[0].status).toBe("supervised_only_for_solo");
  });

  it("does not block for supervising role with supervised-only holding", () => {
    const out = computeCompetencyMismatch({
      ...base, role: "supervising",
      requirements: [req("spec", "c1", "required", "supervising")],
      staffCompetencies: [hold("s1", "c1", { level: "supervised" })],
    });
    expect(out.hasBlocker).toBe(false);
    expect(out.rows[0].status).toBe("ok_supervised");
  });

  it("marks expired required as blocking", () => {
    const out = computeCompetencyMismatch({
      ...base,
      requirements: [req("spec", "c1")],
      staffCompetencies: [hold("s1", "c1", { level: "independent", expires_at: "2026-01-01" })],
    });
    expect(out.rows[0].status).toBe("expired");
    expect(out.hasBlocker).toBe(true);
  });

  it("flags expiring within 30 days as non-blocking", () => {
    const out = computeCompetencyMismatch({
      ...base,
      requirements: [req("spec", "c1")],
      staffCompetencies: [hold("s1", "c1", { level: "independent", expires_at: "2026-07-20" })],
    });
    expect(out.rows[0].status).toBe("expiring");
    expect(out.rows[0].blocking).toBe(false);
    expect(out.hasBlocker).toBe(false);
    expect(out.rows[0].daysUntilExpiry).toBe(13);
  });

  it("sorts blockers first, then required, then recommended", () => {
    const out = computeCompetencyMismatch({
      ...base,
      requirements: [
        req("spec", "c2", "recommended"),
        req("spec", "c1", "required"),
      ],
      staffCompetencies: [hold("s1", "c1", { level: "independent" })],
      // c1 held (ok), c2 missing (but recommended, non-blocking)
    });
    expect(out.rows.map((r) => r.competencyCode)).toEqual(["C1", "C2"]);
    expect(out.hasBlocker).toBe(false);
  });

  it("returns no rows when specialty has no requirements", () => {
    const out = computeCompetencyMismatch({
      ...base,
      requirements: [req("other-spec", "c1")],
      staffCompetencies: [],
    });
    expect(out.rows).toEqual([]);
    expect(out.hasBlocker).toBe(false);
  });
});
