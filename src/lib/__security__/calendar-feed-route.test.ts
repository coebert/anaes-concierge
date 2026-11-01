import type { Dyn, ThenCb } from "@/test-utils/dyn";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { escapeIcsText, foldIcsLine } from "@/lib/ics";

type Result = { data: unknown; error: unknown };
const tables: Record<string, Result | ((call: string[]) => Result)> = {};
const selects: Record<string, string[]> = {};

function chain(table: string) {
  const calls: string[] = [];
  const resolve = () => {
    const t = tables[table];
    return Promise.resolve(typeof t === "function" ? t(calls) : (t ?? { data: [], error: null }));
  };
  const c: Dyn = new Proxy<Dyn>(
    // Proxy target only; every access is intercepted below.
    (() => undefined) as unknown as Dyn,
    {
      get(_t, prop: string) {
        if (prop === "then") return (res: ThenCb, rej: ThenCb) => resolve().then(res, rej);
        if (prop === "maybeSingle") return () => resolve();
        return (...args: unknown[]) => {
          calls.push(prop);
          if (prop === "select") (selects[table] ??= []).push(String(args[0]));
          return c;
        };
      },
    },
  );
  return c;
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chain(t) }),
}));

const TOKEN = "a".repeat(64);
async function call() {
  const { Route } = await import("@/routes/api/public/calendar/$token");
  return (Route as unknown as Dyn).options.server.handlers.GET({
    params: { token: TOKEN },
  }) as Promise<Response>;
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(selects)) delete selects[k];
  tables.profiles = {
    data: { id: "u1", full_name: "Dr Ünïcode, Test", active: true },
    error: null,
  };
  tables.user_roles = { data: [{ role: "staff" }], error: null };
  tables.rota_assignments = {
    data: [
      {
        id: "r1",
        session_date: "2026-11-02",
        session: "am",
        duty_type: "theatre",
        notes: "line1\r\nline2",
      },
    ],
    error: null,
  };
  tables.leave_requests = {
    data: [
      {
        id: "l1",
        type: "sick",
        status: "approved",
        start_date: "2026-11-05",
        end_date: "2026-11-05",
      },
    ],
    error: null,
  };
});

describe("calendar feed route", () => {
  it("serves a private, CRLF-terminated feed with low-disclosure leave", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const body = await res.text();
    expect(body.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
    expect(body).toContain("SUMMARY:Leave (approved)");
    expect(body).not.toMatch(/sick/i);
    // Assignment notes are free text and are never published to the feed.
    expect(body).not.toMatch(/Notes:|line1|line2/);
    expect(selects.leave_requests.join()).not.toContain("reason");
  });
  it("returns 503 (not a partial 200) when leave cannot be read", async () => {
    tables.leave_requests = { data: null, error: { message: "boom" } };
    expect((await call()).status).toBe(503);
  });
  it("returns 503 when rota assignments cannot be read", async () => {
    tables.rota_assignments = { data: null, error: { message: "boom" } };
    expect((await call()).status).toBe(503);
  });
  it("revokes the feed for inactive staff and accounts without a role", async () => {
    tables.profiles = { data: { id: "u1", full_name: "X", active: false }, error: null };
    expect((await call()).status).toBe(404);
    tables.profiles = { data: { id: "u1", full_name: "X", active: true }, error: null };
    tables.user_roles = { data: [], error: null };
    expect((await call()).status).toBe(404);
  });
  it("returns 503 when the token lookup errors", async () => {
    tables.profiles = { data: null, error: { message: "down" } };
    expect((await call()).status).toBe(503);
  });
});

describe("ICS text helpers", () => {
  it("folds at 75 UTF-8 octets without splitting characters", () => {
    const line = "SUMMARY:" + "é".repeat(100);
    const folded = foldIcsLine(line);
    const parts = folded.split("\r\n");
    for (const p of parts) expect(new TextEncoder().encode(p).byteLength).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
  });
  it("escapes bare CR, CRLF, commas, semicolons and control characters", () => {
    expect(escapeIcsText("a\rb\r\nc,d;e\u0007")).toBe("a\\nb\\nc\\,d\\;e");
  });
});
