import { describe, it, expect } from "vitest";
import {
  buildConsultantSessionSet,
  isSoloTraineeAssignment,
  type SoloAssignment,
  type SoloProfile,
} from "./solo-stats";

const profiles = new Map<string, SoloProfile>([
  ["cons-1", { id: "cons-1", grade: "consultant" }],
  ["cons-2", { id: "cons-2", grade: "consultant" }],
  ["train-1", { id: "train-1", grade: "trainee" }],
  ["train-2", { id: "train-2", grade: "trainee" }],
  ["sas-1", { id: "sas-1", grade: "sas" }],
]);

const base = {
  session_date: "2026-05-28",
  session: "am" as const,
  role_on_list: "solo",
  duty_type: "theatre",
  supervisor_id: null,
};

describe("solo-trainee detection", () => {
  it("counts trainees solo when no consultant shares the theatre_session_id", () => {
    const assignments: SoloAssignment[] = [
      { ...base, staff_id: "train-1", theatre_session_id: "ts-1" },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    expect(consSet.size).toBe(0);
    expect(isSoloTraineeAssignment(assignments[0], consSet, profiles)).toBe(true);
  });

  it("does NOT count trainee as solo when a consultant is on the same theatre_session_id", () => {
    const assignments: SoloAssignment[] = [
      { ...base, staff_id: "cons-1", theatre_session_id: "ts-1" },
      { ...base, staff_id: "train-1", theatre_session_id: "ts-1" },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    expect(consSet.has("ts-1")).toBe(true);
    expect(isSoloTraineeAssignment(assignments[1], consSet, profiles)).toBe(false);
  });

  it("does NOT count trainee as solo when supervisor_id is set", () => {
    const assignments: SoloAssignment[] = [
      {
        ...base,
        staff_id: "train-1",
        theatre_session_id: "ts-1",
        supervisor_id: "cons-2",
      },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    expect(isSoloTraineeAssignment(assignments[0], consSet, profiles)).toBe(false);
  });

  it("does NOT count as solo when theatre_session_id is missing (cannot verify)", () => {
    const assignments: SoloAssignment[] = [
      { ...base, staff_id: "train-1", theatre_session_id: null },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    expect(isSoloTraineeAssignment(assignments[0], consSet, profiles)).toBe(false);
  });

  it("does NOT count as solo when role_on_list is not 'solo'", () => {
    const assignments: SoloAssignment[] = [
      {
        ...base,
        staff_id: "train-1",
        theatre_session_id: "ts-1",
        role_on_list: "on_call",
      },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    expect(isSoloTraineeAssignment(assignments[0], consSet, profiles)).toBe(false);
  });

  it("two trainees + consultant on same session: neither trainee is solo", () => {
    const assignments: SoloAssignment[] = [
      { ...base, staff_id: "cons-1", theatre_session_id: "ts-1" },
      { ...base, staff_id: "train-1", theatre_session_id: "ts-1" },
      { ...base, staff_id: "train-2", theatre_session_id: "ts-1" },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    expect(isSoloTraineeAssignment(assignments[1], consSet, profiles)).toBe(false);
    expect(isSoloTraineeAssignment(assignments[2], consSet, profiles)).toBe(false);
  });

  it("multiple sessions: only the session without consultant is solo", () => {
    const assignments: SoloAssignment[] = [
      // ts-1 has a consultant -> trainee on ts-1 not solo
      { ...base, staff_id: "cons-1", theatre_session_id: "ts-1" },
      { ...base, staff_id: "train-1", theatre_session_id: "ts-1" },
      // ts-2 has only a trainee -> solo
      { ...base, staff_id: "train-2", theatre_session_id: "ts-2" },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    const solos = assignments.filter((a) =>
      isSoloTraineeAssignment(a, consSet, profiles),
    );
    expect(solos.map((a) => a.staff_id)).toEqual(["train-2"]);
  });

  it("SAS on the session does not mark the trainee as not solo", () => {
    const assignments: SoloAssignment[] = [
      { ...base, staff_id: "sas-1", theatre_session_id: "ts-1" },
      { ...base, staff_id: "train-1", theatre_session_id: "ts-1" },
    ];
    const consSet = buildConsultantSessionSet(assignments, profiles);
    // only consultants disqualify a "solo" trainee — SAS sharing a list still solo
    expect(isSoloTraineeAssignment(assignments[1], consSet, profiles)).toBe(true);
  });
});
