import { describe, it, expect } from "vitest";
import {
  computeTraineeProgress,
  computeEligibility,
} from "./progress";
import type {
  Competency,
  CompetencyRequirement,
  StaffCompetency,
} from "./competencies";

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

const specs = [{ id: "s-card", name: "Cardiac" }, { id: "s-paeds", name: "Paediatric" }];
const comps = [comp("c-tee", "TOE"), comp("c-paeds", "Paeds airway")];

describe("computeTraineeProgress", () => {
  it("marks missing required competencies", () => {
    const out = computeTraineeProgress({
      staffId: "t1", onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee")],
      staffCompetencies: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].requiredHeld).toBe(0);
    expect(out[0].requiredTotal).toBe(1);
    expect(out[0].items[0].status).toBe("missing");
  });

  it("counts a held independent sign-off as complete", () => {
    const out = computeTraineeProgress({
      staffId: "t1", onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee")],
      staffCompetencies: [hold("t1", "c-tee", { level: "independent" })],
    });
    expect(out[0].requiredHeld).toBe(1);
    expect(out[0].items[0].status).toBe("signed_off_independent");
  });

  it("flags expiring sign-offs within 30 days", () => {
    const out = computeTraineeProgress({
      staffId: "t1", onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee")],
      staffCompetencies: [hold("t1", "c-tee", { level: "independent", expires_at: "2026-07-20" })],
    });
    expect(out[0].items[0].status).toBe("expiring");
    expect(out[0].items[0].daysUntilExpiry).toBe(13);
  });

  it("skips specialties with no requirements", () => {
    const out = computeTraineeProgress({
      staffId: "t1", onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee")],
      staffCompetencies: [],
    });
    expect(out.map((s) => s.specialtyId)).toEqual(["s-card"]);
  });

  it("treats revoked and expired holdings as not held", () => {
    const out = computeTraineeProgress({
      staffId: "t1", onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee")],
      staffCompetencies: [
        hold("t1", "c-tee", { level: "independent", revoked_at: "2026-01-01" }),
      ],
    });
    expect(out[0].requiredHeld).toBe(0);
    expect(out[0].items[0].status).toBe("revoked");
  });
});

describe("computeEligibility", () => {
  const staff = [
    { staffId: "c1", fullName: "Zoe Consultant", grade: "consultant" as const },
    { staffId: "c2", fullName: "Anna Consultant", grade: "consultant" as const },
    { staffId: "t1", fullName: "Trainee Bob", grade: "trainee" as const },
  ];

  it("lists consultants holding all required competencies as solo eligible", () => {
    const out = computeEligibility({
      onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee", "required", "solo")],
      staff,
      staffCompetencies: [
        hold("c1", "c-tee", { level: "independent" }),
        hold("c2", "c-tee", { level: "independent" }),
      ],
    });
    const card = out.find((s) => s.specialtyId === "s-card")!;
    expect(card.solo.map((s) => s.staffId).sort()).toEqual(["c1", "c2"]);
    expect(card.solo[0].fullName).toBe("Anna Consultant"); // alpha sort
  });

  it("excludes staff whose only holding is supervised-level from solo", () => {
    const out = computeEligibility({
      onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee", "required", "solo")],
      staff,
      staffCompetencies: [hold("c1", "c-tee", { level: "supervised" })],
    });
    const card = out.find((s) => s.specialtyId === "s-card")!;
    expect(card.solo).toHaveLength(0);
  });

  it("distinguishes supervising-only eligibility", () => {
    const out = computeEligibility({
      onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [
        req("s-card", "c-tee", "required", "solo"),
        req("s-card", "c-tee", "required", "supervising"),
      ],
      staff,
      staffCompetencies: [hold("c1", "c-tee", { level: "supervised" })],
    });
    const card = out.find((s) => s.specialtyId === "s-card")!;
    expect(card.solo).toHaveLength(0);
    expect(card.supervising.map((s) => s.staffId)).toEqual(["c1"]);
  });

  it("ignores recommended-only requirements for eligibility", () => {
    const out = computeEligibility({
      onDate: "2026-07-07",
      specialties: specs, competencies: comps,
      requirements: [req("s-card", "c-tee", "recommended", "solo")],
      staff, staffCompetencies: [],
    });
    const card = out.find((s) => s.specialtyId === "s-card")!;
    // No required reqs -> everyone trivially eligible.
    expect(card.solo).toHaveLength(3);
  });
});
