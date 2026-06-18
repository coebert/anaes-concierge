/**
 * Row-type checklist for the global calendar search filter.
 *
 * For every row type rendered by `GlobalWeekGrid` we assert that the
 * shared matcher correctly:
 *   - matches by specialty (where the row has one)
 *   - matches by surgical consultant (theatre rows)
 *   - matches by staff name (every row type)
 *   - dims (returns false) when none of the cell's parts contain
 *     the query
 *   - dims empty cells when a query is active, and never dims when
 *     the query is blank
 *
 * Row types covered: Theatre AM/PM, SPA, Admin, Consultant-in-charge,
 * Obstetrics / Labour ward, ICU, On-call (general/registrar/SHO),
 * NHH 1st On-call.
 */
import { describe, it, expect } from "vitest";
import {
  buildSearchTokens,
  cellMatchesSearch,
  shouldDimCell,
} from "@/lib/calendar-search";

type RowFixture = {
  row: string;
  /** Parts the matcher sees for a populated cell. */
  parts: Array<string | null | undefined>;
  /** One probe per searchable dimension that should match this cell. */
  hits: { specialty?: string; consultant?: string; staff?: string };
  /** A query that must NOT match this cell. */
  miss: string;
};

const FIXTURES: RowFixture[] = [
  {
    row: "Theatre AM/PM",
    parts: ["Orthopaedics", "Mr. Patel", "Jane Doe", "Alex Lee"],
    hits: { specialty: "ortho", consultant: "patel", staff: "alex" },
    miss: "cardio",
  },
  {
    row: "SPA",
    parts: ["Jane Doe", "John Smith"],
    hits: { staff: "smith" },
    miss: "ortho",
  },
  {
    row: "Admin",
    parts: ["Priya Kumar"],
    hits: { staff: "priya" },
    miss: "patel",
  },
  {
    row: "Consultant in charge",
    parts: ["Dr Site Lead"],
    hits: { staff: "site lead" },
    miss: "obstetrics",
  },
  {
    row: "Obstetrics / Labour ward",
    parts: ["Obs Consultant", "Obs 2nd Reg"],
    hits: { staff: "obs 2nd" },
    miss: "icu",
  },
  {
    row: "ICU",
    parts: ["ICU Cons", "ICU CT2 Trainee", "ICU Junior"],
    hits: { staff: "junior" },
    miss: "theatre",
  },
  {
    row: "On-call",
    parts: ["Gen Cons", "Reg Oncall", "SHO Oncall"],
    hits: { staff: "sho" },
    miss: "ward round",
  },
  {
    row: "NHH 1st On-call",
    parts: ["Night Cover Consultant"],
    hits: { staff: "night cover" },
    miss: "day surgery",
  },
];

describe("calendar search — row-type checklist", () => {
  it("blank query never dims and matches every row", () => {
    const tokens = buildSearchTokens("   ");
    expect(tokens).toEqual([]);
    for (const f of FIXTURES) {
      expect(cellMatchesSearch(tokens, f.parts)).toBe(true);
      expect(shouldDimCell(tokens, true, f.parts)).toBe(false);
      // Empty cell + blank query also never dims.
      expect(shouldDimCell(tokens, false, [])).toBe(false);
    }
  });

  it.each(FIXTURES)(
    "$row: matches specialty/consultant/staff hits and dims on miss",
    (f) => {
      for (const [kind, query] of Object.entries(f.hits) as Array<
        [string, string]
      >) {
        const tokens = buildSearchTokens(query);
        expect(
          cellMatchesSearch(tokens, f.parts),
          `${f.row} should match by ${kind} ("${query}")`,
        ).toBe(true);
        expect(shouldDimCell(tokens, true, f.parts)).toBe(false);
      }

      const missTokens = buildSearchTokens(f.miss);
      expect(
        cellMatchesSearch(missTokens, f.parts),
        `${f.row} should NOT match "${f.miss}"`,
      ).toBe(false);
      expect(shouldDimCell(missTokens, true, f.parts)).toBe(true);
    },
  );

  it("multi-token queries require every token to match (AND, not OR)", () => {
    const tokens = buildSearchTokens("ortho patel");
    const theatre = FIXTURES[0];
    expect(cellMatchesSearch(tokens, theatre.parts)).toBe(true);
    // Drop the consultant — query no longer matches.
    expect(
      cellMatchesSearch(tokens, theatre.parts.filter((p) => p !== "Mr. Patel")),
    ).toBe(false);
  });

  it("empty cells dim while a query is active for every row type", () => {
    const tokens = buildSearchTokens("anyone");
    for (const f of FIXTURES) {
      expect(
        shouldDimCell(tokens, false, []),
        `${f.row}: empty cell should dim under an active query`,
      ).toBe(true);
    }
  });
});
