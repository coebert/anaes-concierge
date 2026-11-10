import { describe, it, expect } from "vitest";
import {
  buildTheatrePressureForecast,
  extractListEvidence,
  loadSessionLabelSignals,
  loadTheatrePressureEvidence,
  type RawAssignment,
  type RawSession,
  type RawTheatre,
  type SessionLabelSignal,
  type StaffingDayInput,
} from "./theatre-pressure";

// Synthetic fixtures only — no real rota, staff or patient data.
const MON = "2030-01-07";
const TUE = "2030-01-08";
const RANGE = { rangeStart: MON, rangeEnd: TUE };
const T1: RawTheatre = { id: "th-1", name: "Theatre A", active: true };
const T2: RawTheatre = { id: "th-2", name: "Theatre B", active: true };
const THEATRES = [T1, T2];
const OK: StaffingDayInput[] = [MON, TUE].map((date) => ({
  date,
  am: { risk: "ok" },
  pm: { risk: "ok" },
}));

const sess = (id: string, p: Partial<RawSession> = {}): RawSession => ({
  id,
  session_date: MON,
  session: "am",
  theatre_id: T1.id,
  surgical_consultant: null,
  notes: null,
  ...p,
});
const sig = (id: string, p: Partial<SessionLabelSignal> = {}): SessionLabelSignal => ({
  theatre_session_id: id,
  has_title: false,
  has_note: false,
  has_place_note: false,
  title_tags: [],
  note_tags: [],
  title_group: null,
  scan_truncated: false,
  source_rows_seen: 1,
  evidence_complete: true,
  ...p,
});

function build(
  sessions: RawSession[],
  signals: SessionLabelSignal[] | null,
  assignments: RawAssignment[] = [],
) {
  return buildTheatrePressureForecast({
    ...RANGE,
    evidence: extractListEvidence(
      sessions,
      THEATRES,
      assignments,
      signals ?? [],
      signals ? "available" : "not_installed",
    ),
    staffing: OK,
  });
}

describe("derived source signals", () => {
  it("tags from an imported list NOTE are found even when the title has none", () => {
    const f = build([sess("a")], [sig("a", { has_title: true, has_note: true, note_tags: ["DIEP"], title_group: 1 })]);
    expect(f.days[0].lists[0].tags).toEqual(["DIEP"]);
    expect(f.days[0].lists[0].sources).toEqual(["imported_list_note"]);
    expect(f.unverifiedSlots.filter((u) => u.date === MON && u.half)).toEqual([]);
  });

  it("unknown tag names from the server are dropped", () => {
    const f = build([sess("a")], [sig("a", { has_title: true, title_tags: ["VRAM", "<script>"] })]);
    expect(f.days[0].lists[0].tags).toEqual(["VRAM"]);
  });

  it("AM/PM with the same server title group is one all-day list; different groups are two", () => {
    const same = build(
      [sess("a"), sess("b", { session: "pm" })],
      [
        sig("a", { has_title: true, title_tags: ["Robotic"], title_group: 1 }),
        sig("b", { has_title: true, title_tags: ["Robotic"], title_group: 1 }),
      ],
    );
    expect(same.days[0].lists).toHaveLength(1);
    expect(same.days[0].lists[0].identity).toBe("all_day_same_title");
    const diff = build(
      [sess("a"), sess("b", { session: "pm" })],
      [
        sig("a", { has_title: true, title_tags: ["Robotic"], title_group: 1 }),
        sig("b", { has_title: true, title_tags: ["Robotic"], title_group: 2 }),
      ],
    );
    expect(diff.days[0].distinctMin).toBe(2);
  });
});

describe("Unverified slots queue", () => {
  it("lists blank individual sessions with date, theatre, half and a distinct reason", () => {
    const sessions = [
      sess("blank"), // complete import, no title/note → blank in source
      sess("partial", { theatre_id: T2.id }), // import for the day skipped rows
      sess("labelled", { session: "pm" }), // place note only → known label
      sess("legacy", { session: "pm", theatre_id: T2.id }), // pre-capture, has linked rows
      sess("norows", { session_date: TUE }), // no linked rows, no signal
    ];
    const f = build(
      sessions,
      [
        sig("blank"),
        sig("partial", { evidence_complete: false }),
        sig("labelled", { has_place_note: true }),
      ],
      [{ theatre_session_id: "legacy", notes: null }],
    );
    const rows = f.unverifiedSlots.map((u) => [u.date, u.theatreName, u.half, u.reason]);
    expect(rows).toEqual([
      [MON, "Theatre A", "am", "blank_in_source"],
      [MON, "Theatre B", "am", "partial_evidence"],
      [MON, "Theatre B", "pm", "not_captured"],
      [TUE, "Theatre A", "am", "no_linked_rows"],
    ]);
    expect(f.totals.unverifiedSlots).toBe(4);
    expect(f.labelCapture).toBe("available");
  });

  it("a whole weekday without imported lists is its own entry (not zero risk)", () => {
    const f = build([sess("a", { surgical_consultant: "plain" })], []);
    expect(f.unverifiedSlots).toEqual([
      { key: `${TUE}-day`, date: TUE, theatreName: null, half: null, reason: "no_imported_lists" },
    ]);
  });

  it("legacy records keep working before capture is installed", () => {
    const f = build(
      [sess("t", { surgical_consultant: "Synthetic VRAM" }), sess("u", { theatre_id: T2.id })],
      null,
    );
    expect(f.labelCapture).toBe("not_installed");
    expect(f.days[0].lists[0].tags).toEqual(["VRAM"]);
    expect(f.unverifiedSlots[0]).toMatchObject({ theatreName: "Theatre B", reason: "no_linked_rows" });
    expect(f.totals.untitledLists).toBe(1);
  });

  it("refresh: a later import that supplies a title removes the slot from the queue", () => {
    const before = build([sess("a")], [sig("a")]);
    expect(before.unverifiedSlots.some((u) => u.half === "am")).toBe(true);
    const after = build([sess("a")], [sig("a", { has_title: true, title_group: 1 })]);
    expect(after.unverifiedSlots.some((u) => u.half === "am")).toBe(false);
  });

  it("queue carries no raw text or record identifiers", () => {
    const f = build(
      [sess("sess-secret-id", { notes: null, surgical_consultant: null })],
      [sig("sess-secret-id")],
      [{ theatre_session_id: "sess-secret-id", notes: null }],
    );
    const json = JSON.stringify(f);
    expect(json).not.toContain("sess-secret-id");
    expect(json).not.toContain("th-1");
  });
});

describe("signal loader", () => {
  type Res = { data: SessionLabelSignal[] | null; error: { code?: string; message?: string } | null };
  function rpcClient(pages: (from: number) => Res) {
    const calls: Array<{ fn: string; args: unknown; from: number; to: number }> = [];
    return {
      calls,
      client: {
        rpc(fn: string, args: unknown) {
          return {
            order: () => ({
              range: (from: number, to: number) => {
                calls.push({ fn, args, from, to });
                return Promise.resolve(pages(from));
              },
            }),
          };
        },
      },
    };
  }
  const many = (k: number, offset = 0) =>
    Array.from({ length: k }, (_, i) => sig(`s-${String(i + offset).padStart(5, "0")}`));

  it("pages beyond 1000 signals", async () => {
    const all = many(1500);
    const c = rpcClient((from) => ({ data: all.slice(from, from + 1000), error: null }));
    const r = await loadSessionLabelSignals(MON, TUE, c.client);
    expect(r.labelCapture).toBe("available");
    expect(r.signals).toHaveLength(1500);
    expect(c.calls[0]).toMatchObject({ fn: "get_theatre_session_label_signals", args: { p_from: MON, p_to: TUE } });
  });

  it("missing function → not_installed (legacy fallback), no throw", async () => {
    const c = rpcClient(() => ({ data: null, error: { code: "PGRST202", message: "not found" } }));
    expect(await loadSessionLabelSignals(MON, TUE, c.client)).toEqual({
      signals: [],
      labelCapture: "not_installed",
    });
  });

  it("permission or later-page errors throw (Retry), never a silent empty", async () => {
    const denied = rpcClient(() => ({ data: null, error: { code: "42501", message: "not authorised" } }));
    await expect(loadSessionLabelSignals(MON, TUE, denied.client)).rejects.toThrow();
    const all = many(1500);
    const page2 = rpcClient((from) =>
      from === 0
        ? { data: all.slice(0, 1000), error: null }
        : { data: null, error: { code: "PGRST202", message: "x" } },
    );
    await expect(loadSessionLabelSignals(MON, TUE, page2.client)).rejects.toThrow();
  });

  it("full evidence loader wires signals into lists", async () => {
    const tables: Record<string, unknown[]> = {
      theatre_sessions: [sess("a")],
      theatres: THEATRES,
      rota_assignments: [],
    };
    const client = {
      from(table: string) {
        const c: Record<string, unknown> = {};
        for (const m of ["select", "gte", "lte", "not", "order"]) c[m] = () => c;
        c.range = (from: number, to: number) =>
          Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null });
        return c;
      },
      ...rpcClient(() => ({ data: [sig("a", { has_title: true, title_tags: ["DIEP"] })], error: null })).client,
    };
    const ev = await loadTheatrePressureEvidence(MON, TUE, client as never);
    expect(ev.labelCapture).toBe("available");
    expect(ev.lists[0].tags).toEqual(["DIEP"]);
    expect(ev.lists[0].labelStatus).toBe("labelled");
  });
});
