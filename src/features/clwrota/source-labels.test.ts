import { describe, it, expect } from "vitest";
import {
  SourceLabelCollector,
  extractRowSourceLabels,
  isMissingRelationError,
  MAX_VALUE_CHARS,
  MAX_VALUES_PER_FIELD,
  persistSourceLabels,
  planSourceLabelWrites,
  type SourceLabelClient,
  type SourceLabelRecord,
  type StoredSourceLabels,
} from "./source-labels";

// Synthetic rota rows only — no real rota, staff or patient data.
const D1 = "2030-03-04";
const D2 = "2030-03-05";
const K_AM = `${D1}|th-1|am`;
const K_PM = `${D1}|th-1|pm`;
const K_D2 = `${D2}|th-1|am`;
const IDS = new Map([
  [K_AM, "sess-am"],
  [K_PM, "sess-pm"],
  [K_D2, "sess-d2"],
]);
const NOW = "2030-03-01T00:00:00.000Z";

function plan(c: SourceLabelCollector, existing: StoredSourceLabels[] = []) {
  return planSourceLabelWrites({
    collector: c,
    sessionIdByKey: IDS,
    existing: new Map(existing.map((e) => [e.theatre_session_id, e])),
    nowIso: NOW,
  });
}

describe("title and note are kept separately, as supplied", () => {
  it("distinct list title vs list note vs place note", () => {
    const r = extractRowSourceLabels({
      slot_titles: "Synthetic VRAM list",
      slot_notes: "Synthetic note DIEP",
      place: { name: "Room 1", additional_info: "Off site" },
    });
    expect(r).toEqual({
      titles: ["Synthetic VRAM list"],
      notes: ["Synthetic note DIEP"],
      placeNotes: ["Off site"],
    });
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, r);
    const [rec] = plan(c).records;
    expect(rec.list_titles).toEqual(["Synthetic VRAM list"]);
    expect(rec.list_notes).toEqual(["Synthetic note DIEP"]);
    expect(rec.place_notes).toEqual(["Off site"]);
    expect(rec.title_tags).toEqual(["VRAM"]);
    expect(rec.note_tags).toEqual(["DIEP"]);
  });

  it("a real note is not suppressed by an earlier non-empty field (no first-non-empty fallback)", () => {
    const r = extractRowSourceLabels({
      "place.name": "Room 1",
      slot_titles: "T",
      slot_notes: "Robotic note",
      activity: "Other activity",
    });
    expect(r.notes).toEqual(["Robotic note"]);
    expect(r.titles).toEqual(["T"]);
  });

  it("array values are all kept; non-strings are ignored", () => {
    const r = extractRowSourceLabels({ slot_titles: ["A list", " ", 7, "B list"], slot_notes: [] });
    expect(r.titles).toEqual(["A list", "B list"]);
    expect(r.notes).toEqual([]);
  });

  it("dotted and nested place notes are both read", () => {
    expect(extractRowSourceLabels({ "place.additional_info": "Dotted" }).placeNotes).toEqual([
      "Dotted",
    ]);
  });
});

describe("repeated rows and repeated imports", () => {
  it("dedupes values across many rows of one list, keeps distinct ones in order", () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: ["List X"], notes: ["note one"], placeNotes: [] });
    c.observe(K_AM, D1, { titles: [" list   x "], notes: ["Note Two"], placeNotes: [] });
    c.observe(K_AM, D1, { titles: ["List Y"], notes: ["NOTE ONE"], placeNotes: [] });
    const [rec] = plan(c).records;
    expect(rec.list_titles).toEqual(["List X", "List Y"]);
    expect(rec.list_notes).toEqual(["note one", "Note Two"]);
    expect(rec.source_rows_seen).toBe(3);
    expect(rec.evidence_complete).toBe(true);
  });

  it("re-running the same import produces identical records (idempotent)", () => {
    const build = () => {
      const c = new SourceLabelCollector();
      c.observe(K_AM, D1, { titles: ["A"], notes: ["B"], placeNotes: [] });
      c.observe(K_PM, D1, { titles: ["A"], notes: [], placeNotes: [] });
      return plan(c).records;
    };
    expect(build()).toEqual(build());
  });

  it("caps values per field and value length", () => {
    const c = new SourceLabelCollector();
    const many = Array.from({ length: 30 }, (_, i) => `title ${i}`);
    c.observe(K_AM, D1, { titles: many, notes: ["x".repeat(5000)], placeNotes: [] });
    const [rec] = plan(c).records;
    expect(rec.list_titles).toHaveLength(MAX_VALUES_PER_FIELD);
    expect(rec.list_notes[0]).toHaveLength(MAX_VALUE_CHARS);
    expect(rec.scan_truncated).toBe(true);
  });
});

describe("partial imports and confirmed removals", () => {
  const prior: StoredSourceLabels = {
    theatre_session_id: "sess-am",
    list_titles: ["Old title"],
    list_notes: ["Old note"],
    place_notes: [],
  };

  it("complete date: blank source values replace stored ones (confirmed removal)", () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: [], notes: [], placeNotes: [] });
    const [rec] = plan(c, [prior]).records;
    expect(rec.list_titles).toEqual([]);
    expect(rec.list_notes).toEqual([]);
    expect(rec.evidence_complete).toBe(true);
    expect(rec.source_rows_seen).toBe(1);
  });

  it("incomplete date: stored values are kept and merged, marked not complete", () => {
    const c = new SourceLabelCollector();
    c.markUncertain(D1);
    c.observe(K_AM, D1, { titles: ["New title"], notes: [], placeNotes: [] });
    c.observe(K_D2, D2, { titles: [], notes: [], placeNotes: [] });
    const p = plan(c, [prior]);
    const am = p.records.find((r) => r.theatre_session_id === "sess-am")!;
    const d2 = p.records.find((r) => r.theatre_session_id === "sess-d2")!;
    expect(am.list_titles).toEqual(["Old title", "New title"]);
    expect(am.list_notes).toEqual(["Old note"]);
    expect(am.evidence_complete).toBe(false);
    // Other date unaffected by D1's uncertainty.
    expect(d2.evidence_complete).toBe(true);
    expect(p.mergeIds).toEqual(["sess-am"]);
  });

  it("an unparseable date makes every date incomplete", () => {
    const c = new SourceLabelCollector();
    c.markUncertain(null);
    c.observe(K_D2, D2, { titles: [], notes: [], placeNotes: [] });
    expect(plan(c).records[0].evidence_complete).toBe(false);
  });

  it("sessions without rows in this run are not touched; unresolved ids are counted", () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: ["A"], notes: [], placeNotes: [] });
    c.observe(`${D1}|th-9|am`, D1, { titles: ["B"], notes: [], placeNotes: [] });
    const p = plan(c, [prior]);
    expect(p.records.map((r) => r.theatre_session_id)).toEqual(["sess-am"]);
    expect(p.unresolved).toBe(1);
  });
});

describe("manual data is never written by the capture", () => {
  it("records contain only the restricted relation's columns", () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: ["A"], notes: ["B"], placeNotes: ["C"] });
    const [rec] = plan(c).records;
    expect(Object.keys(rec).sort()).toEqual(
      [
        "evidence_complete",
        "last_seen_at",
        "list_notes",
        "list_titles",
        "note_tags",
        "place_notes",
        "scan_truncated",
        "source_rows_seen",
        "theatre_session_id",
        "title_tags",
      ].sort(),
    );
    // Coordinator notes / legacy title / assignment notes stay untouched.
    expect(rec).not.toHaveProperty("notes");
    expect(rec).not.toHaveProperty("surgical_consultant");
  });

  it("place notes are kept but never scanned for tags", () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: [], notes: [], placeNotes: ["Robotic site"] });
    const [rec] = plan(c).records;
    expect(rec.title_tags).toEqual([]);
    expect(rec.note_tags).toEqual([]);
  });
});

describe("persistSourceLabels", () => {
  type Err = { code?: string; message?: string } | null;
  function fakeClient(opts: {
    stored?: StoredSourceLabels[];
    selectError?: Err;
    upsertError?: Err;
  }) {
    const upserts: SourceLabelRecord[][] = [];
    const inCalls: string[][] = [];
    const client: SourceLabelClient = {
      from(table) {
        expect(table).toBe("theatre_session_source_labels");
        return {
          select: () => ({
            in: (_col, ids) => {
              inCalls.push(ids);
              return Promise.resolve({
                data: opts.selectError
                  ? null
                  : (opts.stored ?? []).filter((s) => ids.includes(s.theatre_session_id)),
                error: opts.selectError ?? null,
              });
            },
          }),
          upsert: (rows, o) => {
            expect(o.onConflict).toBe("theatre_session_id");
            upserts.push(rows);
            return Promise.resolve({ error: opts.upsertError ?? null });
          },
        };
      },
    };
    return { client, upserts, inCalls };
  }

  it("writes in bounded chunks and only loads stored values for incomplete dates", async () => {
    const ids = new Map<string, string>();
    const c = new SourceLabelCollector();
    for (let i = 0; i < 7; i++) {
      const k = `${D1}|th-${i}|am`;
      ids.set(k, `id-${i}`);
      c.observe(k, D1, { titles: [`t${i}`], notes: [], placeNotes: [] });
    }
    const f = fakeClient({});
    const res = await persistSourceLabels(f.client, c, ids, { nowIso: NOW, upsertChunk: 3 });
    expect(res).toMatchObject({ status: "ok", written: 7 });
    expect(f.upserts.map((u) => u.length)).toEqual([3, 3, 1]);
    expect(f.inCalls).toEqual([]);
  });

  it("merges with stored values on an incomplete date (chunked lookup)", async () => {
    const c = new SourceLabelCollector();
    c.markUncertain(D1);
    c.observe(K_AM, D1, { titles: ["New"], notes: [], placeNotes: [] });
    const f = fakeClient({
      stored: [{ theatre_session_id: "sess-am", list_titles: ["Old"], list_notes: [], place_notes: [] }],
    });
    const res = await persistSourceLabels(f.client, c, IDS, { nowIso: NOW, inChunk: 1 });
    expect(res.status).toBe("ok");
    expect(f.upserts[0][0].list_titles).toEqual(["Old", "New"]);
  });

  it("a failed stored-value lookup stops without writing (never drops labels)", async () => {
    const c = new SourceLabelCollector();
    c.markUncertain(D1);
    c.observe(K_AM, D1, { titles: ["New"], notes: [], placeNotes: [] });
    const f = fakeClient({ selectError: { code: "57014", message: "timeout" } });
    const res = await persistSourceLabels(f.client, c, IDS, { nowIso: NOW });
    expect(res.status).toBe("error");
    expect(f.upserts).toEqual([]);
  });

  it("reports not_installed when the relation doesn't exist yet", async () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: ["A secret-title"], notes: [], placeNotes: [] });
    const f = fakeClient({
      upsertError: {
        code: "PGRST205",
        message: "Could not find the table 'public.theatre_session_source_labels' in the schema cache",
      },
    });
    const res = await persistSourceLabels(f.client, c, IDS, { nowIso: NOW });
    expect(res.status).toBe("not_installed");
    expect(JSON.stringify(res)).not.toContain("secret-title");
  });

  it("other errors are reported without raw values", async () => {
    const c = new SourceLabelCollector();
    c.observe(K_AM, D1, { titles: ["A secret-title"], notes: [], placeNotes: [] });
    const f = fakeClient({ upsertError: { code: "42501", message: "permission denied" } });
    const res = await persistSourceLabels(f.client, c, IDS, { nowIso: NOW });
    expect(res.status).toBe("error");
    expect(JSON.stringify(res)).not.toContain("secret-title");
  });

  it("missing-relation detection is specific", () => {
    expect(isMissingRelationError({ code: "42P01" })).toBe(true);
    expect(isMissingRelationError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingRelationError(null)).toBe(false);
  });
});
