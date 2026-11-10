import { describe, it, expect, vi, beforeEach } from "vitest";

// Synthetic only: no network, no real database. The admin client is a fake
// that records writes; the feed fetch is stubbed.
type Write = { table: string; op: string; row: unknown };
const writes: Write[] = [];
let preCountError: { message: string } | null = null;
let feedUrl: string | null = "https://feed.example/rota.json?start_date=x&end_date=y";

function chain(table: string) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "range", "in", "gte", "lte", "limit"]) c[m] = () => c;
  c.maybeSingle = () =>
    Promise.resolve({
      data:
        table === "clwrota_sync_state"
          ? {
              rota_report_url: feedUrl,
              sync_days_back: 30,
              sync_days_ahead: 120,
              auto_reclassify_trainee_solo: false,
            }
          : null,
      error: null,
    });
  c.upsert = (row: unknown) => {
    writes.push({ table, op: "upsert", row });
    return Promise.resolve({ error: null });
  };
  c.insert = (row: unknown) => {
    writes.push({ table, op: "insert", row });
    return Promise.resolve({ error: null });
  };
  c.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve(
      table === "rota_assignments"
        ? { count: 0, error: preCountError, data: null }
        : { data: [], error: null },
    ).then(ok);
  return c;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => chain(t) },
}));
vi.mock("./settings.functions", () => ({ getEnv: () => ({ apiKey: "synthetic" }) }));
vi.mock("./parsing", async (orig) => ({
  ...(await orig<typeof import("./parsing")>()),
  fetchReportRaw: vi.fn(async () => {
    throw new Error("synthetic feed outage");
  }),
}));

import { performRotaSync } from "./sync.functions";

const windows = () => writes.filter((w) => w.table === "clwrota_sync_windows").map((w) => w.row);

beforeEach(() => {
  writes.length = 0;
  preCountError = null;
  feedUrl = "https://feed.example/rota.json?start_date=x&end_date=y";
});

describe("performRotaSync records a date window for every run", () => {
  it("a chunk whose feed fetch fails is recorded as failed for exactly its slice, and the error still surfaces", async () => {
    await expect(performRotaSync({ from: "2030-01-07", to: "2030-01-13" })).rejects.toThrow(
      /synthetic feed outage/,
    );
    expect(windows()).toEqual([
      expect.objectContaining({
        requested_from: "2030-01-07",
        requested_to: "2030-01-13",
        covered_from: null,
        covered_to: null,
        outcome: "failed",
        explicit_window: true,
      }),
    ]);
  });

  it("a scheduled run that throws early records its explicit window only if it had one", async () => {
    preCountError = { message: "synthetic count failure" };
    await expect(performRotaSync({ from: "2030-02-04", to: "2030-02-10" })).rejects.toThrow();
    expect(windows()).toHaveLength(1);
    writes.length = 0;
    await expect(performRotaSync({})).rejects.toThrow();
    // No resolved window → nothing claimed, nothing invented.
    expect(windows()).toHaveLength(0);
  });

  it("no feed configured → no window recorded", async () => {
    feedUrl = null;
    const r = await performRotaSync({ from: "2030-01-07", to: "2030-01-13" });
    expect(r.ok).toBe(false);
    expect(windows()).toHaveLength(0);
  });
});
