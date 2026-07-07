import { describe, it, expect } from "vitest";
import { computeWeekBlockingCompetencyIssues } from "./week-blockers";
import type {
  Competency, CompetencyRequirement, StaffCompetency,
} from "./competencies";

const comp = (id: string, name = id): Competency => ({
  id, code: id.toUpperCase(), name, description: null,
  category: "subspecialty", applies_to_grades: [], active: true, sort_order: 0,
});
const req = (
  specialty_id: string, competency_id: string,
  applies_to_role: "solo" | "supervising" | "any" = "solo",
): CompetencyRequirement => ({
  id: `${specialty_id}-${competency_id}-${applies_to_role}`,
  specialty_id, competency_id, requirement: "required", applies_to_role,
});
const hold = (
  staff_id: string, competency_id: string,
  overrides: Partial<StaffCompetency> = {},
): StaffCompetency => ({
  id: `${staff_id}-${competency_id}`, staff_id, competency_id,
  level: "independent", granted_at: "2020-01-01",
  expires_at: null, revoked_at: null, notes: null,
  ...overrides,
});

const theatres = [{ id: "th1", name: "Theatre 1" }];
const staff = [
  { id: "s1", full_name: "Anna Anaesthetist" },
  { id: "s2", full_name: "Ben Bloggs" },
];
const specA = "spec-card";
const compTee = comp("c-tee", "TOE");

describe("computeWeekBlockingCompetencyIssues", () => {
  it("groups blocking issues by staff and session", () => {
    const out = computeWeekBlockingCompetencyIssues({
      assignments: [
        { id: "a1", staff_id: "s1", session_date: "2026-07-06", session: "am",
          role_on_list: "solo", theatre_session_id: "ts1" },
        { id: "a2", staff_id: "s2", session_date: "2026-07-07", session: "pm",
          role_on_list: "solo", theatre_session_id: "ts2" },
      ],
      theatreSessions: [
        { id: "ts1", theatre_id: "th1", session: "am", session_date: "2026-07-06", specialty_id: specA },
        { id: "ts2", theatre_id: "th1", session: "pm", session_date: "2026-07-07", specialty_id: specA },
      ],
      theatres, staff,
      competencies: [compTee],
      requirements: [req(specA, "c-tee", "solo")],
      staffCompetencies: [], // nobody signed off — both blocked
    });
    expect(out).toHaveLength(2);
    expect(out[0].staffName).toBe("Anna Anaesthetist");
    expect(out[0].issues[0].session).toBe("am");
    expect(out[0].issues[0].theatreName).toBe("Theatre 1");
    expect(out[1].staffName).toBe("Ben Bloggs");
  });

  it("omits staff with only warnings or no issues", () => {
    const out = computeWeekBlockingCompetencyIssues({
      assignments: [
        { id: "a1", staff_id: "s1", session_date: "2026-07-06", session: "am",
          role_on_list: "solo", theatre_session_id: "ts1" },
      ],
      theatreSessions: [
        { id: "ts1", theatre_id: "th1", session: "am", session_date: "2026-07-06", specialty_id: specA },
      ],
      theatres, staff,
      competencies: [compTee],
      requirements: [req(specA, "c-tee", "solo")],
      staffCompetencies: [hold("s1", "c-tee", { level: "independent" })],
    });
    expect(out).toEqual([]);
  });

  it("skips assignments with no theatre session or specialty", () => {
    const out = computeWeekBlockingCompetencyIssues({
      assignments: [
        { id: "a1", staff_id: "s1", session_date: "2026-07-06", session: "am",
          role_on_list: "solo", theatre_session_id: null },
        { id: "a2", staff_id: "s1", session_date: "2026-07-06", session: "pm",
          role_on_list: "solo", theatre_session_id: "ts-no-spec" },
      ],
      theatreSessions: [
        { id: "ts-no-spec", theatre_id: "th1", session: "pm",
          session_date: "2026-07-06", specialty_id: null },
      ],
      theatres, staff,
      competencies: [compTee],
      requirements: [req(specA, "c-tee", "solo")],
      staffCompetencies: [],
    });
    expect(out).toEqual([]);
  });

  it("ignores non-am/pm sessions (eve, night)", () => {
    const out = computeWeekBlockingCompetencyIssues({
      assignments: [
        { id: "a1", staff_id: "s1", session_date: "2026-07-06", session: "eve",
          role_on_list: "solo", theatre_session_id: "ts1" },
      ],
      theatreSessions: [
        { id: "ts1", theatre_id: "th1", session: "eve", session_date: "2026-07-06", specialty_id: specA },
      ],
      theatres, staff,
      competencies: [compTee],
      requirements: [req(specA, "c-tee", "solo")],
      staffCompetencies: [],
    });
    expect(out).toEqual([]);
  });

  it("orders a staff's issues by date then session", () => {
    const out = computeWeekBlockingCompetencyIssues({
      assignments: [
        { id: "a1", staff_id: "s1", session_date: "2026-07-08", session: "pm",
          role_on_list: "solo", theatre_session_id: "ts3" },
        { id: "a2", staff_id: "s1", session_date: "2026-07-06", session: "pm",
          role_on_list: "solo", theatre_session_id: "ts2" },
        { id: "a3", staff_id: "s1", session_date: "2026-07-06", session: "am",
          role_on_list: "solo", theatre_session_id: "ts1" },
      ],
      theatreSessions: [
        { id: "ts1", theatre_id: "th1", session: "am", session_date: "2026-07-06", specialty_id: specA },
        { id: "ts2", theatre_id: "th1", session: "pm", session_date: "2026-07-06", specialty_id: specA },
        { id: "ts3", theatre_id: "th1", session: "pm", session_date: "2026-07-08", specialty_id: specA },
      ],
      theatres, staff,
      competencies: [compTee],
      requirements: [req(specA, "c-tee", "solo")],
      staffCompetencies: [],
    });
    expect(out[0].issues.map((i) => `${i.date}/${i.session}`)).toEqual([
      "2026-07-06/am", "2026-07-06/pm", "2026-07-08/pm",
    ]);
  });
});
