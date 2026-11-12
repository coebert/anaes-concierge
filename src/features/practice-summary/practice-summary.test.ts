import { describe, expect, it } from "vitest";
import {
  buildPracticeSummary,
  isValidRange,
  practiceSummaryCsv,
  type ListInfo,
  type PracticeRow,
  type WeekImport,
  type WeekPublication,
} from "./practice-summary";
import { tallySpecialtyWorkload } from "@/features/analytics/specialty-workload";
import { dayCountFixture } from "./day-count-fixture";

// Synthetic ids/labels only.
const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const rules = { sessions_per_pa: 1, oncall_pa_credit: 1.5, weekend_pa_credit: 3 };
let n = 0;
const row = (o: Partial<PracticeRow>): PracticeRow => ({
  id: `r${++n}`,
  staff_id: ME,
  session_date: "2030-05-06",
  session: "am",
  duty_type: "theatre",
  extra_type: null,
  pa_credit: null,
  attending_consultant_ids: null,
  theatre_session_id: null,
  source: "clwrota",
  locally_modified: false,
  clwrota_external_id: `p|2030-05-06|am-${n}`,
  ...o,
});
const lists = new Map<string, ListInfo>([
  ["L1", { specialty: "Synthetic Gynae", location: "Synthetic Theatre 1" }],
  ["L2", { specialty: null, location: "Synthetic Theatre 2" }],
]);
const build = (rows: PracticeRow[], o: Partial<Parameters<typeof buildPracticeSummary>[0]> = {}) =>
  buildPracticeSummary({
    userId: ME,
    from: "2030-04-01",
    to: "2031-03-31",
    today: "2030-09-30",
    rows,
    lists,
    rules,
    weekPublication: new Map<string, WeekPublication>(),
    weekImport: new Map<string, WeekImport>(),
    ...o,
  });

describe("buildPracticeSummary", () => {
  it("counts only rows inside the chosen dates (inclusive)", () => {
    const s = build([
      row({ session_date: "2030-03-31" }),
      row({ session_date: "2030-04-01" }),
      row({ session_date: "2031-03-31", session: "pm" }),
      row({ session_date: "2031-04-01" }),
    ]);
    expect(s.scope.rosteredEntries).toBe(2);
    expect(s.months[0].entries).toBe(1);
    expect(s.months.at(-1)!.entries).toBe(1);
    expect(s.months).toHaveLength(12);
  });

  it("ignores another doctor's rows and never outputs their id", () => {
    const s = build([
      row({ staff_id: OTHER }),
      row({
        staff_id: OTHER,
        attending_consultant_ids: [ME],
        theatre_session_id: "L1",
        session_date: "2030-05-07",
      }),
      row({ staff_id: ME, attending_consultant_ids: [OTHER], session_date: "2030-05-08" }),
    ]);
    expect(s.scope.rosteredEntries).toBe(1);
    expect(s.scope.namedOnOtherEntries).toBe(1);
    expect(JSON.stringify(s)).not.toContain(OTHER);
    expect(practiceSummaryCsv(s, { generatedAt: "x" })).not.toContain(OTHER);
  });

  it("uses the shared tally for days, sessions, on-calls and PAs", () => {
    const rows = [
      row({ session: "am", pa_credit: 1 }),
      row({ session: "pm" }),
      row({ session: "eve", duty_type: "general_consultant_oncall", session_date: "2030-05-07" }),
      row({ session: "night", duty_type: "general_consultant_oncall", session_date: "2030-05-07" }),
      row({ session: "am", session_date: "2030-05-11" }), // Saturday
      row({ session: "am", extra_type: "locum (paid)", session_date: "2030-05-13" }),
    ];
    const s = build(rows);
    const shared = tallySpecialtyWorkload(rows, rules).filter((t) => t.staff_id === ME);
    expect(s.totals.totalPas).toBe(
      Math.round(shared.reduce((a, t) => a + t.totalPas, 0) * 100) / 100,
    );
    expect(s.totals.onCalls).toBe(1); // eve + night on one date = one on-call
    expect(s.totals.weekendDays).toBe(1);
    expect(s.totals.extraSessions).toBe(1);
    expect(s.totals.clwrotaPas).toBe(1);
    expect(s.onCall.onCallDates).toBe(1);
    expect(s.quality.estimatedPaEntries).toBe(4); // pm, eve, night, Saturday; extra row excluded
  });

  it("groups duties by half-day and shows ICU/obstetrics/teaching only when present", () => {
    const s = build([
      row({ session: "am", duty_type: "icu_consultant_oncall" }),
      row({ session: "night", duty_type: "icu_consultant_oncall", session_date: "2030-05-09" }),
      row({ session: "pm", duty_type: "spa" }),
    ]);
    expect(s.dutyGroups.find((g) => g.group === "Intensive care")).toMatchObject({
      entries: 2,
      halves: { am: 1, pm: 0, eve: 0, night: 1 },
    });
    expect(s.icu).toEqual({ entries: 2, daytimeSessions: 1, onCallDates: 1 });
    expect(s.obstetrics).toBeNull();
    expect(s.teaching).toBeNull();
  });

  it("separates entries from distinct half-days and reports splits and overlaps", () => {
    const s = build([
      row({
        session: "am",
        duty_type: "medical_examiner",
        clwrota_external_id: "9|2030-05-06|AM|am",
      }),
      row({
        session: "pm",
        duty_type: "medical_examiner",
        clwrota_external_id: "9|2030-05-06|AM|pm",
      }),
      row({ staff_id: OTHER, attending_consultant_ids: [ME], session: "am" }),
    ]);
    expect(s.scope.distinctHalfDays).toBe(2);
    expect(s.scope.rosteredEntries + s.scope.namedOnOtherEntries).toBe(3);
    expect(s.scope.halfDaysWithSeveralEntries).toBe(1);
    expect(s.scope.splitAllDayEntries).toBe(2);
  });

  it("reports unlinked theatre rows, lists without specialty, locations and app edits", () => {
    const s = build([
      row({ theatre_session_id: null }),
      row({ theatre_session_id: "L1", session_date: "2030-05-07" }),
      row({ theatre_session_id: "L2", session_date: "2030-05-08", locally_modified: true }),
      row({ source: "manual", session_date: "2030-05-09", duty_type: "admin" }),
      row({ session: "allday" as string, session_date: "2030-05-10" }),
    ]);
    expect(s.quality).toMatchObject({
      theatreNotLinkedToList: 1,
      listWithoutSpecialty: 1,
      locallyEditedEntries: 1,
      enteredInApp: 1,
      unknownHalfExcluded: 1,
    });
    expect(s.areas.map((a) => a.area)).toContain("Synthetic Gynae");
    expect(s.locations).toEqual([
      { location: "Synthetic Theatre 1", entries: 1 },
      { location: "Synthetic Theatre 2", entries: 1 },
    ]);
  });

  it("labels partial coverage per entry's week, unobserved weeks as not observed", () => {
    const s = build(
      [
        row({ session_date: "2030-05-06" }),
        row({ session_date: "2030-05-13" }),
        row({ session_date: "2030-05-20" }),
      ],
      {
        weekPublication: new Map<string, WeekPublication>([
          ["2030-05-06", "published"],
          ["2030-05-13", "not_setup"],
        ]),
        weekImport: new Map<string, WeekImport>([
          ["2030-05-06", "current"],
          ["2030-05-13", "before_tracking"],
        ]),
      },
    );
    expect(s.coverage.byPublication).toEqual({ published: 1, not_setup: 1, not_observed: 1 });
    expect(s.coverage.byImport).toEqual({ current: 1, before_tracking: 1, not_tracked: 1 });
  });

  it("splits past from planned future entries", () => {
    const s = build([row({ session_date: "2030-09-30" }), row({ session_date: "2030-10-01" })]);
    expect(s.scope).toMatchObject({ pastEntries: 1, futureEntries: 1 });
  });

  it("an empty range is all zeros, not an error", () => {
    const s = build([]);
    expect(s.totals.totalPas).toBe(0);
    expect(s.icu).toBeNull();
    expect(s.months.every((m) => m.entries === 0)).toBe(true);
  });
});

describe("isValidRange", () => {
  it("accepts an appraisal year and rejects reversed, malformed or over-long ranges", () => {
    expect(isValidRange("2030-04-01", "2031-03-31")).toBe(true);
    expect(isValidRange("2030-04-02", "2030-04-01")).toBe(false);
    expect(isValidRange("2030-4-1", "2031-03-31")).toBe(false);
    expect(isValidRange("2030-01-01", "2031-02-04")).toBe(true); // exactly 400 days
    expect(isValidRange("2030-01-01", "2031-02-05")).toBe(false); // 401 days
  });
});

describe("practiceSummaryCsv", () => {
  it("is aggregate-only, quoted, and neutralises formula-like cells", () => {
    const s = build([row({ theatre_session_id: "L1" })], {
      lists: new Map([["L1", { specialty: "=HYPERLINK(1)", location: "@cmd" }]]),
    });
    const csv = practiceSummaryCsv(s, { generatedAt: "2030-10-01T00:00:00Z" });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe('"section","item","measure","value"');
    expect(csv).toContain(`"area","'=HYPERLINK(1)","sessions","1"`);
    expect(csv).toContain(`"location","'@cmd","entries","1"`);
    expect(csv).not.toMatch(/r\d+"/); // no row ids
    expect(csv).toContain('"report","basis","note"');
  });
});

describe("days with daytime work (report-wide)", () => {
  it("counts a date once when AM and PM are in different specialties", () => {
    const s = build([
      row({ session_date: "2030-05-06", session: "am", theatre_session_id: "L1" }),
      row({ session_date: "2030-05-06", session: "pm", duty_type: "spa" }),
    ]);
    expect(s.areas.map((a) => a.days)).toEqual([1, 1]);
    expect(s.totals.days).toBe(1);
    expect(s.totals.sessions).toBe(2);
  });

  it("counts AM + PM in the same specialty as one day", () => {
    const s = build([
      row({ session_date: "2030-05-06", session: "am", theatre_session_id: "L1" }),
      row({ session_date: "2030-05-06", session: "pm", theatre_session_id: "L1" }),
    ]);
    expect(s.totals.days).toBe(1);
  });

  it("does not count an evening-only date; an extra-session-only date counts", () => {
    const s = build([
      row({ session_date: "2030-05-06", session: "eve", duty_type: "general_consultant_oncall" }),
      row({ session_date: "2030-05-07", session: "am", extra_type: "wli" }),
      row({ session_date: "2030-05-08", session: "am" }),
    ]);
    expect(s.totals.days).toBe(2);
    expect(s.totals.sessions).toBe(1);
    expect(s.totals.onCalls).toBe(1);
    expect(s.totals.extraSessions).toBe(1);
  });

  it("201 entries over 119 dates read 119, not the 149 specialty sum; CSV matches", () => {
    const fx = dayCountFixture();
    const s = build(fx.rows, { lists: fx.lists });
    expect(fx.rows.filter((r) => r.session === "am" || r.session === "pm")).toHaveLength(201);
    expect(s.areas.reduce((a, x) => a + x.days, 0)).toBe(149);
    expect(s.totals.days).toBe(119);
    expect(s.totals.sessions).toBe(197);
    expect(s.totals.extraSessions).toBe(4);
    expect(s.scope.distinctDays).toBe(120);
    expect(practiceSummaryCsv(s, { generatedAt: "x" })).toContain('"totals","all","days","119"');
  });

  it("keeps specialty days and PAs unchanged", () => {
    const fx = dayCountFixture();
    const s = build(fx.rows, { lists: fx.lists });
    const by = Object.fromEntries(s.areas.map((a) => [a.area, a]));
    expect(by["Synthetic Gynae"].days).toBe(80);
    expect(by["Synthetic Ortho"].days).toBe(69);
    expect(s.totals.totalPas).toBe(
      Math.round(s.areas.reduce((a, x) => a + x.totalPas, 0) * 100) / 100,
    );
  });
});
