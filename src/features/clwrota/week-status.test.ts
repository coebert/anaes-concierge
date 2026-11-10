import { describe, it, expect } from "vitest";
import {
  WeekStatusCollector,
  isoWeekStart,
  normaliseRotaStatus,
  persistWeekStatus,
  planWeekStatusWrites,
  type StoredWeekStatus,
  type WeekStatusClient,
  type WeekStatusRecord,
} from "./week-status";

// Synthetic only. Feed vocabulary as verified: "Published", "Setup", "Not setup".
const NOW = "2030-01-20T08:00:00.000Z";
const EARLIER = "2030-01-01T08:00:00.000Z";

describe("normalisation and weeks", () => {
  it("maps the feed's three verified values and keeps others distinct", () => {
    expect(normaliseRotaStatus("Published")).toBe("published");
    expect(normaliseRotaStatus("Setup")).toBe("setup");
    expect(normaliseRotaStatus("Not setup")).toBe("not_setup");
    expect(normaliseRotaStatus("not_set_up")).toBe("not_setup");
    // "Draft" is the weekly view's word; the feed never sent it — not mapped.
    expect(normaliseRotaStatus("Draft")).toBe("other");
    expect(normaliseRotaStatus("")).toBeNull();
    expect(normaliseRotaStatus(null)).toBeNull();
  });

  it("ISO week starts on Monday", () => {
    expect(isoWeekStart("2030-01-07")).toBe("2030-01-07"); // Monday
    expect(isoWeekStart("2030-01-13")).toBe("2030-01-07"); // Sunday
    expect(isoWeekStart("2030-01-01")).toBe("2029-12-31"); // Tuesday, crosses year
  });
});

describe("plan", () => {
  it("records each observed week with its feed status and state counts", () => {
    const c = new WeekStatusCollector();
    c.observe("2030-01-07", "Published", "actual");
    c.observe("2030-01-08", "Published", "actual");
    c.observe("2030-01-14", "Setup", "actual");
    c.observe("2030-01-21", "Not setup", "planned");
    c.observe("2030-01-22", "Not setup", "actual");
    const recs = planWeekStatusWrites({ collector: c, existing: new Map(), nowIso: NOW });
    expect(
      recs.map((r) => [r.week_start, r.status_code, r.rows_seen, r.planned_rows, r.actual_rows]),
    ).toEqual([
      ["2030-01-07", "published", 2, 0, 2],
      ["2030-01-14", "setup", 1, 0, 1],
      ["2030-01-21", "not_setup", 2, 1, 1],
    ]);
    expect(recs[0].source_values).toEqual(["Published"]);
    expect(recs[0].dates_seen).toBe(2);
  });

  it("never writes a week the feed returned no rows for (no inference from missing rows)", () => {
    const c = new WeekStatusCollector();
    c.observe("2030-01-07", "Published", "actual");
    c.observe("2030-01-21", "Published", "actual");
    const weeks = planWeekStatusWrites({ collector: c, existing: new Map(), nowIso: NOW }).map(
      (r) => r.week_start,
    );
    expect(weeks).toEqual(["2030-01-07", "2030-01-21"]);
  });

  it("mixed, blank and unrecognised statuses stay distinct", () => {
    const c = new WeekStatusCollector();
    c.observe("2030-01-07", "Published", "actual");
    c.observe("2030-01-08", "Setup", "actual");
    c.observe("2030-01-14", null, "actual");
    c.observe("2030-01-21", "Locked", "actual");
    c.observe("2030-01-28", "Dr X <b>", "weird");
    const recs = planWeekStatusWrites({ collector: c, existing: new Map(), nowIso: NOW });
    expect(recs.map((r) => r.status_code)).toEqual(["mixed", "unknown", "other", "other"]);
    expect(recs[2].source_values).toEqual(["Locked"]);
    // Non-word raw values are never stored.
    expect(recs[3].source_values).toEqual([]);
    expect(recs[3].other_state_rows).toBe(1);
  });

  it("keeps first-seen and status-since across unchanged runs; resets since on change", () => {
    const prior: StoredWeekStatus = {
      week_start: "2030-01-14",
      status_code: "setup",
      first_observed_at: EARLIER,
      status_since: EARLIER,
      previous_status_code: "not_setup",
    };
    const same = new WeekStatusCollector();
    same.observe("2030-01-14", "Setup", "actual");
    const [a] = planWeekStatusWrites({
      collector: same,
      existing: new Map([[prior.week_start, prior]]),
      nowIso: NOW,
    });
    expect([a.first_observed_at, a.status_since, a.previous_status_code, a.observed_at]).toEqual([
      EARLIER,
      EARLIER,
      "not_setup",
      NOW,
    ]);
    const changed = new WeekStatusCollector();
    changed.observe("2030-01-14", "Published", "actual");
    const [b] = planWeekStatusWrites({
      collector: changed,
      existing: new Map([[prior.week_start, prior]]),
      nowIso: NOW,
    });
    expect([b.status_code, b.first_observed_at, b.status_since, b.previous_status_code]).toEqual([
      "published",
      EARLIER,
      NOW,
      "setup",
    ]);
  });

  it("records only aggregate, non-personal columns", () => {
    const c = new WeekStatusCollector();
    c.observeRow("2030-01-07", {
      rota_status: "Published",
      state: "actual",
      "person.first_name": "Synthetic",
      "extra_submittal.submitted_by": "Someone",
    });
    const [r] = planWeekStatusWrites({ collector: c, existing: new Map(), nowIso: NOW });
    expect(Object.keys(r).sort()).toEqual(
      [
        "actual_rows",
        "dates_seen",
        "first_observed_at",
        "observed_at",
        "other_state_rows",
        "planned_rows",
        "previous_status_code",
        "rows_seen",
        "source_values",
        "status_code",
        "status_since",
        "week_start",
      ].sort(),
    );
    expect(JSON.stringify(r)).not.toMatch(/Synthetic|Someone/);
  });
});

describe("persist", () => {
  type Err = { code?: string; message?: string } | null;
  function client(o: { stored?: StoredWeekStatus[]; selectError?: Err; upsertError?: Err }) {
    const upserts: WeekStatusRecord[][] = [];
    const c: WeekStatusClient = {
      from: (t) => {
        expect(t).toBe("clwrota_week_status");
        return {
          select: () => ({
            in: (_c, keys) =>
              Promise.resolve({
                data: o.selectError
                  ? null
                  : (o.stored ?? []).filter((s) => keys.includes(s.week_start)),
                error: o.selectError ?? null,
              }),
          }),
          upsert: (rows, opts) => {
            expect(opts.onConflict).toBe("week_start");
            upserts.push(rows);
            return Promise.resolve({ error: o.upsertError ?? null });
          },
        };
      },
    };
    return { c, upserts };
  }
  const one = () => {
    const col = new WeekStatusCollector();
    col.observe("2030-01-07", "Published", "actual");
    return col;
  };

  it("writes observed weeks", async () => {
    const f = client({});
    expect(await persistWeekStatus(f.c, one(), { nowIso: NOW })).toEqual({
      status: "ok",
      written: 1,
    });
    expect(f.upserts[0][0].status_code).toBe("published");
  });
  it("nothing observed → nothing written", async () => {
    const f = client({});
    expect(await persistWeekStatus(f.c, new WeekStatusCollector(), { nowIso: NOW })).toEqual({
      status: "ok",
      written: 0,
    });
    expect(f.upserts).toEqual([]);
  });
  it("missing table → not_installed", async () => {
    const f = client({ selectError: { code: "PGRST205", message: "not found" } });
    expect((await persistWeekStatus(f.c, one(), { nowIso: NOW })).status).toBe("not_installed");
  });
  it("lookup failure stops without writing", async () => {
    const f = client({ selectError: { code: "57014", message: "timeout" } });
    expect((await persistWeekStatus(f.c, one(), { nowIso: NOW })).status).toBe("error");
    expect(f.upserts).toEqual([]);
  });
});
