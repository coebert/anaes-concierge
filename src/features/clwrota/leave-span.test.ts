/**
 * Regression: the leave_events feed is one row per leave day; each row also
 * carries the request's own span (leave_request.start_date/end_date). The
 * import used to read the event's start_time/end_time and keep whichever row
 * came last, so a multi-day request was stored as its last day only.
 * Synthetic rows only.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const upserts: Array<Record<string, unknown>> = [];
let feedBody = "";

vi.mock("./settings.functions", () => ({
  getEnv: () => ({ apiKey: "k", baseUrl: "https://example.test" }),
}));
vi.mock("./parsing", async (orig) => ({
  ...((await orig()) as object),
  fetchReportRaw: async () => feedBody,
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const result = () => {
      if (table === "clwrota_sync_state")
        return {
          data: {
            leave_report_url:
              "https://example.test/central_api/query/leave_events?start_date=2030-01-01&end_date=2030-12-31",
          },
          error: null,
        };
      if (table === "profiles")
        return {
          data: [
            {
              id: "staff-1",
              email: "a@example.test",
              full_name: "Synthetic A",
              clwrota_external_id: "11",
            },
          ],
          error: null,
        };
      return { data: [], error: null, count: 0 };
    };
    for (const m of ["select", "eq", "not", "in", "gte", "lte", "order", "range", "limit"])
      b[m] = () => b;
    b.maybeSingle = async () => result();
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    b.upsert = (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
      if (table === "leave_requests") upserts.push(...(Array.isArray(rows) ? rows : [rows]));
      return {
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
        select: () => Promise.resolve({ data: [], error: null }),
      };
    };
    b.insert = () => Promise.resolve({ error: null });
    return b;
  };
  return { supabaseAdmin: { from: builder, rpc: async () => ({ data: null, error: null }) } };
});

const event = (
  date: string,
  half: "am" | "pm",
  req: { id: number; start: string; end: string },
) => ({
  date,
  start_time: `${date}T${half === "am" ? "08:00" : "13:00"}:00+00:00`,
  end_time: `${date}T${half === "am" ? "12:00" : "17:00"}:00+00:00`,
  duration: "04:00:00",
  person: { email: "a@example.test", local_id: 11, rota_name: "Synthetic A" },
  leave_type: { name: "Annual Leave" },
  leave_request: {
    local_id: req.id,
    state: "approved",
    start_date: req.start,
    end_date: req.end,
    details: null,
  },
});

describe("leave import keeps each request's full span", () => {
  beforeEach(() => {
    upserts.length = 0;
  });

  it("stores a five-day request as five days, not its last event", async () => {
    const req = { id: 501, start: "2030-03-04", end: "2030-03-08" };
    const rows = ["2030-03-04", "2030-03-05", "2030-03-06", "2030-03-07", "2030-03-08"].flatMap(
      (d) => [event(d, "am", req), event(d, "pm", req)],
    );
    feedBody = JSON.stringify(rows);
    const { performLeaveSync } = await import("./leave.functions");
    await performLeaveSync();
    const r = upserts.find((u) => u.clwrota_external_id === "501");
    expect(r).toMatchObject({
      start_date: "2030-03-04",
      end_date: "2030-03-08",
      staff_id: "staff-1",
    });
  });

  it("falls back to the widest event span when the request dates are absent", async () => {
    const req = { id: 502, start: "", end: "" };
    feedBody = JSON.stringify([
      event("2030-04-02", "am", req),
      event("2030-04-01", "am", req),
      event("2030-04-03", "pm", req),
    ]);
    const { performLeaveSync } = await import("./leave.functions");
    await performLeaveSync();
    const r = upserts.find((u) => u.clwrota_external_id === "502");
    expect(r).toMatchObject({ start_date: "2030-04-01", end_date: "2030-04-03" });
  });
});
