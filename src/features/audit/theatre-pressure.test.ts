import { describe, it, expect } from "vitest";
import {
  buildTheatrePressureForecast,
  detectProcedureTags,
  extractListEvidence,
  loadTheatrePressureEvidence,
  TAG_SCAN_MAX_CHARS,
  type RawAssignment,
  type RawSession,
  type RawTheatre,
  type StaffingDayInput,
} from "./theatre-pressure";
import type { HalfDayCapacity } from "./robustness";

// Synthetic fixtures only — no real rota, staff or patient data.
const MON = "2030-01-07"; // Monday
const TUE = "2030-01-08";
const SAT = "2030-01-12";
const RANGE = { rangeStart: MON, rangeEnd: "2030-01-13" };

const T1: RawTheatre = { id: "th-1", name: "Theatre A", active: true };
const T2: RawTheatre = { id: "th-2", name: "Theatre B", active: true };
const T_ROBOT_ROOM: RawTheatre = { id: "th-3", name: "Robotic Suite", active: true };
const T_OLD: RawTheatre = { id: "th-4", name: "Legacy", active: false };
const THEATRES = [T1, T2, T_ROBOT_ROOM, T_OLD];

let n = 0;
function sess(p: Partial<RawSession>): RawSession {
  n += 1;
  return {
    id: `s-${n}`,
    session_date: MON,
    session: "am",
    theatre_id: T1.id,
    surgical_consultant: "Synthetic general list",
    notes: null,
    ...p,
  };
}

type Risk = HalfDayCapacity["risk"];
function staffing(date: string, am: Risk, pm: Risk): StaffingDayInput {
  return { date, am: { risk: am }, pm: { risk: pm } };
}
const OK_WEEK: StaffingDayInput[] = ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11"].map(
  (d) => staffing(d, "ok", "ok"),
);
const withDay = (s: StaffingDayInput) => OK_WEEK.map((d) => (d.date === s.date ? s : d));

function forecast(
  sessions: RawSession[],
  opts: { assignments?: RawAssignment[]; staffing?: StaffingDayInput[] | null } = {},
) {
  return buildTheatrePressureForecast({
    ...RANGE,
    evidence: extractListEvidence(sessions, THEATRES, opts.assignments ?? []),
    staffing: opts.staffing === undefined ? OK_WEEK : opts.staffing,
  });
}

describe("detectProcedureTags — explicit, case-insensitive, bounded", () => {
  it("matches each explicit label in any case", () => {
    expect(detectProcedureTags("vram list")).toEqual(["VRAM"]);
    expect(detectProcedureTags("Mr Synthetic DIEP")).toEqual(["DIEP"]);
    expect(detectProcedureTags("ROBOT")).toEqual(["Robotic"]);
    expect(detectProcedureTags("robotic prostatectomy")).toEqual(["Robotic"]);
    expect(detectProcedureTags("Robotics")).toEqual(["Robotic"]);
    expect(detectProcedureTags("(VRAM)/diep-flap")).toEqual(["VRAM", "DIEP"]);
    expect(detectProcedureTags("Robot-assisted")).toEqual(["Robotic"]);
  });
  it("does not match inside longer words", () => {
    for (const s of ["diepoxide", "vrams", "irobot", "robotically", "xvram", "robots", "DIEP2"]) {
      expect(detectProcedureTags(s)).toEqual([]);
    }
  });
  it("only scans the first TAG_SCAN_MAX_CHARS characters", () => {
    const long = "x".repeat(TAG_SCAN_MAX_CHARS) + " DIEP";
    expect(detectProcedureTags(long)).toEqual([]);
    expect(detectProcedureTags(null)).toEqual([]);
  });
});

describe("no inference from surgeon, theatre name or specialty", () => {
  it("a theatre named 'Robotic Suite' with an untagged title yields no tagged list", () => {
    const f = forecast([sess({ theatre_id: T_ROBOT_ROOM.id, surgical_consultant: "Mr Synthetic" })]);
    expect(f.days).toEqual([]);
  });
  it("a surgeon name alone never produces a tag", () => {
    const f = forecast([sess({ surgical_consultant: "Ms Synthetic Plastics Surgeon" })]);
    expect(f.days).toEqual([]);
  });
});

describe("deduplication", () => {
  it("repeated linked assignments and multiple tags collapse into one list", () => {
    const s = sess({ surgical_consultant: "DIEP" });
    const f = forecast([s], {
      assignments: [
        { theatre_session_id: s.id, notes: "VRAM" },
        { theatre_session_id: s.id, notes: "vram" },
        { theatre_session_id: s.id, notes: "VRAM" },
      ],
    });
    expect(f.days).toHaveLength(1);
    expect(f.days[0].lists).toHaveLength(1);
    expect(f.days[0].lists[0].tags).toEqual(["VRAM", "DIEP"]);
    expect(f.days[0].lists[0].sources).toEqual(["imported_list_title", "assignment_note"]);
    expect(f.days[0].distinctMin).toBe(1);
    expect(f.days[0].distinctMax).toBe(1);
  });

  it("AM + PM in the same theatre with the same title is one all-day list", () => {
    const f = forecast([
      sess({ session: "am", surgical_consultant: "Synthetic  DIEP " }),
      sess({ session: "pm", surgical_consultant: "synthetic diep" }),
    ]);
    const d = f.days[0];
    expect(d.lists).toHaveLength(1);
    expect(d.lists[0].halves).toEqual(["am", "pm"]);
    expect(d.lists[0].identity).toBe("all_day_same_title");
    expect(d.distinctMin).toBe(1);
    expect(d.reasons.map((r) => r.code)).not.toContain("multiple_tagged_lists");
  });

  it("AM/PM pair with differing or missing titles is unresolved: a range, never confirmed", () => {
    const f = forecast([
      sess({ session: "am", surgical_consultant: "DIEP synthetic one" }),
      sess({ session: "pm", surgical_consultant: null, notes: null }),
    ], {
      assignments: [],
    });
    // PM has no title and no tag → only the AM list is tagged.
    expect(f.days[0].lists).toHaveLength(1);

    const g = forecast([
      sess({ session: "am", surgical_consultant: "DIEP synthetic one" }),
      sess({ session: "pm", surgical_consultant: "DIEP synthetic two" }),
    ]);
    const d = g.days[0];
    expect(d.lists.map((l) => l.identity)).toEqual([
      "possibly_same_as_other_half",
      "possibly_same_as_other_half",
    ]);
    expect([d.distinctMin, d.distinctMax]).toEqual([1, 2]);
    expect(d.reasons.map((r) => r.code)).toContain("possible_multiple_tagged_lists");
    expect(d.reasons.map((r) => r.code)).not.toContain("multiple_tagged_lists");
    expect(g.totals.unresolvedPairs).toBe(1);
  });

  it("AM/PM pair with different titles and different procedures counts as two lists", () => {
    const f = forecast([
      sess({ session: "am", surgical_consultant: "DIEP synthetic" }),
      sess({ session: "pm", surgical_consultant: "Robotic synthetic" }),
    ]);
    expect([f.days[0].distinctMin, f.days[0].distinctMax]).toEqual([2, 2]);
  });
});

describe("staffing escalation", () => {
  const twoAm = () => [
    sess({ theatre_id: T1.id, surgical_consultant: "DIEP" }),
    sess({ theatre_id: T2.id, surgical_consultant: "Robot" }),
  ];

  it("two distinct tagged lists alone → potential pressure", () => {
    const d = forecast(twoAm()).days[0];
    expect(d.level).toBe("potential");
    expect(d.reasons.map((r) => r.code)).toEqual(["multiple_tagged_lists"]);
  });

  for (const risk of ["tight", "spa_required", "shortfall"] as const) {
    it(`two tagged lists + ${risk} cover in the same half → elevated`, () => {
      const d = forecast(twoAm(), { staffing: withDay(staffing(MON, risk, "ok")) }).days[0];
      expect(d.level).toBe("elevated");
      expect(d.reasons.map((r) => r.code)).toContain("multiple_lists_constrained_cover");
    });
  }

  it("tight cover in the OTHER half does not elevate", () => {
    const d = forecast(twoAm(), { staffing: withDay(staffing(MON, "ok", "shortfall")) }).days[0];
    expect(d.level).toBe("potential");
    expect(d.reasons.map((r) => r.code)).not.toContain("multiple_lists_constrained_cover");
  });

  it("single tagged list with tight cover is flagged as a separate reason", () => {
    const d = forecast([sess({ surgical_consultant: "VRAM" })], {
      staffing: withDay(staffing(MON, "spa_required", "ok")),
    }).days[0];
    expect(d.level).toBe("potential");
    expect(d.reasons.map((r) => r.code)).toEqual(["tagged_list_constrained_cover"]);
  });

  it("single tagged list with OK cover carries no pressure reason", () => {
    const d = forecast([sess({ surgical_consultant: "VRAM" })]).days[0];
    expect(d.level).toBe("noted");
    expect(d.reasons).toEqual([]);
  });

  it("unconfirmed pair + tight cover is potential, not elevated", () => {
    const d = forecast(
      [
        sess({ session: "am", surgical_consultant: "DIEP one" }),
        sess({ session: "pm", surgical_consultant: "DIEP two" }),
      ],
      { staffing: withDay(staffing(MON, "tight", "ok")) },
    ).days[0];
    expect(d.level).toBe("potential");
  });
});

describe("absent or incomplete inputs are unverified, not zero risk", () => {
  it("missing staffing (null) marks every tagged half not verified", () => {
    const f = forecast([sess({ surgical_consultant: "DIEP" })], { staffing: null });
    expect(f.staffingAvailable).toBe(false);
    expect(f.days[0].lists[0].staffing).toEqual([{ half: "am", status: "not_assessed" }]);
    expect(f.days[0].level).toBe("unverified");
    expect(f.totals.unverifiedDays).toBe(1);
  });

  it("weekend and evening lists are not assessed", () => {
    const f = forecast([
      sess({ session_date: SAT, surgical_consultant: "Robotic" }),
      sess({ session_date: TUE, session: "eve", surgical_consultant: "VRAM" }),
    ]);
    for (const d of f.days) {
      expect(d.lists[0].staffing[0].status).toBe("not_assessed");
      expect(d.reasons.map((r) => r.code)).toContain("staffing_not_verified");
    }
  });

  it("counts untitled lists and weekdays with no imported lists", () => {
    const f = forecast([
      sess({ surgical_consultant: "DIEP" }),
      sess({ theatre_id: T2.id, surgical_consultant: null, notes: null }),
    ]);
    expect(f.totals.untitledLists).toBe(1);
    expect(f.days[0].untitledLists).toBe(1);
    expect(f.days[0].reasons.map((r) => r.code)).toContain("untitled_lists_same_day");
    // Tue–Fri have no lists at all → 4 unassessed weekdays.
    expect(f.totals.weekdaysWithoutLists).toBe(4);
  });

  it("tagged lists on inactive theatres are excluded and counted", () => {
    const f = forecast([sess({ theatre_id: T_OLD.id, surgical_consultant: "DIEP" })]);
    expect(f.days).toEqual([]);
    expect(f.totals.excludedInactiveTagged).toBe(1);
  });
});

describe("privacy", () => {
  it("forecast output contains no raw label text or record identifiers", () => {
    const s1 = sess({ surgical_consultant: "Mr Zyxwv DIEP secretword", notes: "coordnote VRAM" });
    const s2 = sess({ theatre_id: T2.id, surgical_consultant: "Robotic Qwerty" });
    const f = forecast([s1, s2], {
      assignments: [{ theatre_session_id: s2.id, notes: "assignment private-note robot" }],
    });
    const json = JSON.stringify(f);
    for (const leak of ["Zyxwv", "secretword", "coordnote", "Qwerty", "private-note", s1.id, s2.id, "th-1", "th-2"]) {
      expect(json).not.toContain(leak);
    }
    expect(json).toContain("Theatre A");
  });
});

describe("loader uses complete paging and fails loudly", () => {
  type Row = Record<string, unknown>;
  function client(tables: Record<string, Row[]>, failOn?: { table: string; from: number }) {
    return {
      from(table: string) {
        const calls: string[] = [];
        const c: Record<string, unknown> = {};
        for (const m of ["select", "gte", "lte", "not", "order"]) {
          c[m] = (...args: unknown[]) => {
            calls.push(`${m}:${JSON.stringify(args)}`);
            return c;
          };
        }
        c.range = (from: number, to: number) => {
          if (failOn && failOn.table === table && failOn.from === from) {
            return Promise.resolve({ data: null, error: { message: "page failed" } });
          }
          const rows = tables[table] ?? [];
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        };
        return c;
      },
    };
  }
  const many = (k: number) =>
    Array.from({ length: k }, (_, i) => ({
      id: `s-${String(i).padStart(5, "0")}`,
      session_date: MON,
      session: "am",
      theatre_id: T1.id,
      surgical_consultant: i === k - 1 ? "DIEP" : "plain",
      notes: null,
    }));

  it("reads beyond the first 1000 rows (tag on row 2,500 is found)", async () => {
    const ev = await loadTheatrePressureEvidence(
      MON,
      MON,
      client({ theatre_sessions: many(2500), theatres: THEATRES as unknown as Row[], rota_assignments: [] }) as never,
    );
    expect(ev.lists).toHaveLength(2500);
    expect(ev.lists.filter((l) => l.tags.length).length).toBe(1);
  });

  it("a failed later page throws instead of returning a short list", async () => {
    await expect(
      loadTheatrePressureEvidence(
        MON,
        MON,
        client(
          { theatre_sessions: many(2500), theatres: THEATRES as unknown as Row[], rota_assignments: [] },
          { table: "theatre_sessions", from: 1000 },
        ) as never,
      ),
    ).rejects.toThrow();
  });
});
