import { describe, expect, it } from "vitest";
import { buildLocationCells } from "./location-line";

const sessions = [
  { id: "s1", session_date: "2026-11-16", session: "am" },
  { id: "s2", session_date: "2026-11-16", session: "pm" },
  { id: "s3", session_date: "2026-11-17", session: "eve" },
];

describe("buildLocationCells", () => {
  it("lists each linked person once on their list's half", () => {
    const cell = buildLocationCells(sessions, [
      { id: "a1", staff_id: "x", theatre_session_id: "s1" },
      { id: "a2", staff_id: "x", theatre_session_id: "s1" },
      { id: "a3", staff_id: "y", theatre_session_id: "s1" },
    ]);
    expect(cell("2026-11-16", "am")).toEqual({ kind: "list", staffIds: ["x", "y"] });
  });

  it("keeps a list with nobody linked distinct from no list", () => {
    const cell = buildLocationCells(sessions, []);
    expect(cell("2026-11-16", "pm")).toEqual({ kind: "list", staffIds: [] });
    expect(cell("2026-11-18", "am")).toEqual({ kind: "no_list" });
  });

  it("ignores evening/night sessions for the AM/PM line", () => {
    const cell = buildLocationCells(sessions, []);
    expect(cell("2026-11-17", "am")).toEqual({ kind: "no_list" });
    expect(cell("2026-11-17", "pm")).toEqual({ kind: "no_list" });
  });
});
