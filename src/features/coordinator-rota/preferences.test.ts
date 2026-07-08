import { describe, it, expect } from "vitest";
import {
  compareStaffByPreference,
  type EvaluatePreferenceInput,
  type StaffPracticePref,
  type StaffSpecialtyPref,
  type PreferenceLevel,
} from "./preferences";

type Staff = {
  id: string;
  full_name: string;
  grade: "consultant" | "sas" | "trainee";
};

interface Ctx {
  specialtyId: string;
  specialtyName: string;
  practice: Map<string, StaffPracticePref>;
  spec: Map<string, StaffSpecialtyPref>;
}

const makeCtx = (specialtyName: string): Ctx => ({
  specialtyId: "spec-1",
  specialtyName,
  practice: new Map(),
  spec: new Map(),
});

const setPractice = (
  ctx: Ctx,
  id: string,
  flags: Partial<Omit<StaffPracticePref, "staff_id">> = {},
) => {
  ctx.practice.set(id, {
    staff_id: id,
    covers_obstetrics: !!flags.covers_obstetrics,
    covers_paediatrics: !!flags.covers_paediatrics,
    covers_cleft_palate: !!flags.covers_cleft_palate,
  });
};

const setSpec = (ctx: Ctx, id: string, preference: PreferenceLevel) => {
  ctx.spec.set(id, { staff_id: id, specialty_id: ctx.specialtyId, preference });
};

const toInput = (ctx: Ctx) => (s: Staff): EvaluatePreferenceInput => ({
  staffId: s.id,
  grade: s.grade,
  specialtyId: ctx.specialtyId,
  specialtyName: ctx.specialtyName,
  practicePref: ctx.practice.get(s.id),
  specialtyPref: ctx.spec.get(s.id),
});

const surname = (a: Staff, b: Staff) => a.full_name.localeCompare(b.full_name);

const sortNames = (list: Staff[], ctx: Ctx) =>
  [...list]
    .sort((a, b) => compareStaffByPreference(a, b, toInput(ctx), surname))
    .map((s) => s.full_name);

const alice: Staff = { id: "a", full_name: "Alice", grade: "consultant" };
const bob: Staff = { id: "b", full_name: "Bob", grade: "consultant" };
const carol: Staff = { id: "c", full_name: "Carol", grade: "consultant" };
const dave: Staff = { id: "d", full_name: "Dave", grade: "consultant" };

describe("compareStaffByPreference — dropdown ordering", () => {
  it("orders preferred (★), then matching, then non-matching", () => {
    const ctx = makeCtx("General surgery");
    setSpec(ctx, alice.id, "none"); // non-matching
    setSpec(ctx, bob.id, "preferred"); // preferred
    setSpec(ctx, carol.id, "willing"); // matching
    // dave: no rows → default willing → matching

    expect(sortNames([alice, bob, carol, dave], ctx)).toEqual([
      "Bob",
      "Carol",
      "Dave",
      "Alice",
    ]);
  });

  it("puts multiple preferred first (alphabetical tiebreak)", () => {
    const ctx = makeCtx("General surgery");
    setSpec(ctx, carol.id, "preferred");
    setSpec(ctx, alice.id, "preferred");
    setSpec(ctx, bob.id, "willing");

    expect(sortNames([bob, carol, alice], ctx)).toEqual([
      "Alice",
      "Carol",
      "Bob",
    ]);
  });

  it("keeps preferred at the top even when a required coverage flag is missing", () => {
    // Preferred outranks matching by design — a coordinator explicitly
    // marked this consultant as preferred, so surface them first and let
    // the inline warnings flag the missing coverage.
    const ctx = makeCtx("Obstetric anaesthesia");
    setSpec(ctx, alice.id, "preferred"); // preferred, no obs flag
    setSpec(ctx, bob.id, "willing");
    setPractice(ctx, bob.id, { covers_obstetrics: true }); // matching
    setSpec(ctx, carol.id, "willing"); // non-matching (no obs flag)

    expect(sortNames([carol, bob, alice], ctx)).toEqual([
      "Alice",
      "Bob",
      "Carol",
    ]);
  });

  it("reorders when the specialty changes coverage requirements", () => {
    const build = (specialtyName: string) => {
      const ctx = makeCtx(specialtyName);
      setSpec(ctx, alice.id, "willing");
      setPractice(ctx, alice.id, { covers_paediatrics: true }); // paeds only
      setSpec(ctx, bob.id, "willing");
      setPractice(ctx, bob.id, { covers_obstetrics: true }); // obs only
      setSpec(ctx, carol.id, "preferred"); // always preferred
      return ctx;
    };

    // Obstetrics: Carol (★), Bob (obs), Alice (missing obs)
    expect(sortNames([alice, bob, carol], build("Obstetric anaesthesia"))).toEqual([
      "Carol",
      "Bob",
      "Alice",
    ]);

    // Paediatrics: Carol (★), Alice (paeds), Bob (missing paeds)
    expect(sortNames([alice, bob, carol], build("Paediatric surgery"))).toEqual([
      "Carol",
      "Alice",
      "Bob",
    ]);

    // Cleft: Carol (★), then Alice/Bob both non-matching → alphabetical
    expect(sortNames([alice, bob, carol], build("Cleft palate"))).toEqual([
      "Carol",
      "Alice",
      "Bob",
    ]);

    // No required coverage: Carol (★), Alice/Bob both matching → alphabetical
    expect(sortNames([alice, bob, carol], build("General surgery"))).toEqual([
      "Carol",
      "Alice",
      "Bob",
    ]);
  });

  it("treats trainees as matching regardless of preference rows", () => {
    const trainee: Staff = { id: "t", full_name: "Trainee", grade: "trainee" };
    const ctx = makeCtx("Obstetric anaesthesia");
    setSpec(ctx, bob.id, "preferred"); // preferred consultant
    // alice consultant: default willing, no obs flag → non-matching
    // trainee: grade "trainee" → always matches, never preferred

    expect(sortNames([alice, bob, trainee], ctx)).toEqual([
      "Bob", // preferred
      "Trainee", // matching (grade bypasses coverage checks)
      "Alice", // non-matching consultant
    ]);
  });

  it("respects a 'none' specialty preference even when coverage flags are set", () => {
    const ctx = makeCtx("Obstetric anaesthesia");
    setSpec(ctx, alice.id, "none");
    setPractice(ctx, alice.id, { covers_obstetrics: true });
    setSpec(ctx, bob.id, "willing");
    setPractice(ctx, bob.id, { covers_obstetrics: true });

    expect(sortNames([alice, bob], ctx)).toEqual(["Bob", "Alice"]);
  });

  it("applies the same tiers to SAS grade", () => {
    const s1: Staff = { id: "s1", full_name: "Sami", grade: "sas" };
    const s2: Staff = { id: "s2", full_name: "Sana", grade: "sas" };
    const ctx = makeCtx("General surgery");
    setSpec(ctx, s1.id, "none");
    setSpec(ctx, s2.id, "preferred");

    expect(sortNames([s1, s2], ctx)).toEqual(["Sana", "Sami"]);
  });
});
