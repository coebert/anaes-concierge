import { describe, it, expect } from "vitest";
import { selectStaleNonWorkingExtIds } from "./non-working-cleanup";

// Synthetic keys in the feed's fallback shape: person|date|session.
const key = (person: string, date: string, half: string) => `${person}|${date}|${half}`;

describe("selectStaleNonWorkingExtIds", () => {
  it("keeps a Not setup week working theatre row that shares its key with an Available row", () => {
    const k = key("p1", "2027-01-12", "AM");
    const r = selectStaleNonWorkingExtIds([k], [k]);
    expect(r.stale).toEqual([]);
    expect(r.keptForWorkingRow).toBe(1);
  });

  it("still deletes a key seen only on a non-working row (genuine stale day off)", () => {
    const off = key("p2", "2027-01-12", "AM");
    const r = selectStaleNonWorkingExtIds([off], [key("p3", "2027-01-12", "AM")]);
    expect(r.stale).toEqual([off]);
    expect(r.keptForWorkingRow).toBe(0);
  });

  it("does not protect the same person's other half-day", () => {
    const am = key("p1", "2027-01-12", "AM");
    const pm = key("p1", "2027-01-12", "PM");
    expect(selectStaleNonWorkingExtIds([pm], [am]).stale).toEqual([pm]);
  });

  it("splits a mixed import: 48 shared keys kept, 3 off-only keys deleted", () => {
    const shared = Array.from({ length: 48 }, (_, i) => key(`s${i}`, "2026-12-29", "AM"));
    const offOnly = ["a", "b", "c"].map((p) => key(p, "2026-12-29", "PM"));
    const r = selectStaleNonWorkingExtIds([...shared, ...offOnly], shared);
    expect(r.keptForWorkingRow).toBe(48);
    expect(r.stale.sort()).toEqual([...offOnly].sort());
  });

  it("counts a repeated non-working key once", () => {
    const k = key("p4", "2027-01-05", "AM");
    const r = selectStaleNonWorkingExtIds([k, k], []);
    expect(r.stale).toEqual([k]);
  });

  it("is idempotent: a re-run of the same import deletes nothing new and keeps the same rows", () => {
    const shared = key("p5", "2027-01-19", "PM");
    const offOnly = key("p6", "2027-01-19", "PM");
    const first = selectStaleNonWorkingExtIds([shared, offOnly], [shared]);
    const second = selectStaleNonWorkingExtIds([shared, offOnly], [shared]);
    expect(second).toEqual(first);
    expect(first.stale).toEqual([offOnly]);
  });

  it("protects a key whose working row was later skipped (e.g. staff not matched)", () => {
    // The importer passes keys of every working-classified feed row, not
    // only rows that became drafts, so an unmatched working row still wins.
    const k = key("p7", "2027-01-20", "AM");
    const workingEvidence = new Set([k]);
    const drafts: string[] = [];
    const r = selectStaleNonWorkingExtIds([k], [...workingEvidence, ...drafts]);
    expect(r.stale).toEqual([]);
    expect(r.keptForWorkingRow).toBe(1);
  });
});
