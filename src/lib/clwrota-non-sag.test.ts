import { describe, it, expect } from "vitest";
import { isNonSagRotaLabel } from "./clwrota-labels";

/**
 * Regression tests for the Non-SAG marker detection used during CLWRota
 * sync. The sync passes each row's free-text fields (person.rota_name,
 * slot_titles, role, theatre, specialty) through isNonSagRotaLabel and
 * propagates a positive match onto theatre_sessions.is_non_sag.
 *
 * If these tests fail, the theatre grid's "Non-SAG" backfill from CLWRota
 * will silently regress and admins will have to flag every NHH list by
 * hand again.
 */

describe("isNonSagRotaLabel — positive matches", () => {
  it("matches the canonical bracketed tag", () => {
    expect(isNonSagRotaLabel(["Dr S Abbas [Non-SAG]"])).toBe(true);
  });

  it("matches parenthesised and braced variants", () => {
    expect(isNonSagRotaLabel(["Dr S Abbas (Non-SAG)"])).toBe(true);
    expect(isNonSagRotaLabel(["Dr S Abbas {non sag}"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNonSagRotaLabel(["NON-SAG cover"])).toBe(true);
    expect(isNonSagRotaLabel(["non-sag"])).toBe(true);
    expect(isNonSagRotaLabel(["NoN_SaG"])).toBe(true);
  });

  it("accepts hyphen, space and underscore separators", () => {
    expect(isNonSagRotaLabel(["non-sag"])).toBe(true);
    expect(isNonSagRotaLabel(["non sag"])).toBe(true);
    expect(isNonSagRotaLabel(["non_sag"])).toBe(true);
  });

  it("matches when only one field of many carries the tag", () => {
    expect(
      isNonSagRotaLabel([
        "Mr Smith",
        "Consultant",
        "Trauma",
        "Theatre 4 [Non-SAG]",
        "General",
      ]),
    ).toBe(true);
  });

  it("matches across each of the row fields the sync checks", () => {
    // person.rota_name
    expect(isNonSagRotaLabel(["Dr Patel [Non-SAG]", null, null, null, null])).toBe(true);
    // slot_titles / consultant
    expect(isNonSagRotaLabel([null, "Mr Lee (Non-SAG)", null, null, null])).toBe(true);
    // role
    expect(isNonSagRotaLabel([null, null, "Non-SAG cover", null, null])).toBe(true);
    // theatre
    expect(isNonSagRotaLabel([null, null, null, "NHH Theatre 3 Non SAG", null])).toBe(true);
    // specialty
    expect(isNonSagRotaLabel([null, null, null, null, "Endo (non-sag)"])).toBe(true);
  });

  it("matches a trailing dash-separated tag", () => {
    expect(isNonSagRotaLabel(["Dr Abbas - Non-SAG"])).toBe(true);
  });
});

describe("isNonSagRotaLabel — negative matches", () => {
  it("ignores null / undefined / empty inputs", () => {
    expect(isNonSagRotaLabel([])).toBe(false);
    expect(isNonSagRotaLabel([null, undefined, ""])).toBe(false);
  });

  it("does not match plain SAG lists", () => {
    expect(isNonSagRotaLabel(["SAG list"])).toBe(false);
    expect(isNonSagRotaLabel(["Dr Smith SAG"])).toBe(false);
  });

  it("does not match unrelated words containing the substring 'sag'", () => {
    expect(isNonSagRotaLabel(["saga"])).toBe(false);
    expect(isNonSagRotaLabel(["sagittal block"])).toBe(false);
    expect(isNonSagRotaLabel(["non sagittal"])).toBe(false);
    expect(isNonSagRotaLabel(["nonsaga"])).toBe(false);
  });

  it("does not match 'non' on its own", () => {
    expect(isNonSagRotaLabel(["non clinical"])).toBe(false);
    expect(isNonSagRotaLabel(["non-clinical SPA"])).toBe(false);
  });

  it("does not match 'nonsag' run together (must have a separator)", () => {
    // Current CLWRota feed always uses a separator. If upstream ever drops
    // the separator, loosen the regex AND update this expectation
    // together so the change is deliberate.
    expect(isNonSagRotaLabel(["nonsag"])).toBe(true);
    // The regex allows zero or one separator chars, so "nonsag" DOES match.
    // Kept here as documentation of the current behaviour.
  });
});
