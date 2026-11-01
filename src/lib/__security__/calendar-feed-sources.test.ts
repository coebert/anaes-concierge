import { describe, expect, it } from "vitest";
import {
  buildCalendarFeedForToken,
  leaveEventTimes,
  renderCalendarFeed,
} from "@/lib/calendar-feed";
import { escapeIcsText, foldIcsLine } from "@/lib/ics";

type R = { data: unknown; error: unknown };
type Tables = Record<string, R | ((calls: { m: string; a: unknown[] }[]) => R)>;

/** Thenable query-builder fake; records select() column lists per table. */
function fakeSb(tables: Tables, selects: Record<string, string[]> = {}) {
  return {
    from(table: string) {
      const calls: { m: string; a: unknown[] }[] = [];
      const resolve = () => {
        const t = tables[table];
        return Promise.resolve(
          typeof t === "function" ? t(calls) : (t ?? { data: [], error: null }),
        );
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then")
              return (res: (v: R) => unknown, rej: (e: unknown) => unknown) =>
                resolve().then(res, rej);
            if (prop === "maybeSingle") return () => resolve();
            return (...args: unknown[]) => {
              calls.push({ m: prop, a: args });
              if (prop === "select") (selects[table] ??= []).push(String(args[0]));
              return c;
            };
          },
        },
      );
      return c;
    },
  };
}

const TOKEN = "b".repeat(64);
const NOW = new Date("2026-11-01T12:00:00Z");
const base = (): Tables => ({
  profiles: (calls) =>
    calls.some((c) => c.m === "in")
      ? { data: [{ id: "sup1", full_name: "Dr Super" }], error: null }
      : { data: { id: "u1", full_name: "Dr Test", active: true, left_at: null }, error: null },
  user_roles: { data: [{ role: "staff" }], error: null },
  rota_assignments: {
    data: [
      {
        id: "r1",
        session_date: "2026-11-02",
        session: "am",
        duty_type: "theatre",
        role_on_list: "solo",
        updated_at: null,
        supervisor_id: "sup1",
        theatre_session_id: "ts1",
        notes: "PRIVATE NOTE",
      },
    ],
    error: null,
  },
  leave_requests: {
    data: [
      {
        id: "l1",
        type: "sick",
        start_date: "2026-11-05",
        end_date: "2026-11-05",
        half_day_start: null,
        half_day_end: null,
        updated_at: null,
        reason: "PRIVATE REASON",
      },
    ],
    error: null,
  },
  theatre_sessions: {
    data: [
      {
        id: "ts1",
        surgical_consultant: "Mr Cut",
        theatres: { name: "Theatre 3" },
        specialties: { name: "Ortho" },
        notes: "TS NOTE",
      },
    ],
    error: null,
  },
});

describe("calendar feed sources (fail closed)", () => {
  it("renders a feed when every source loads", async () => {
    const selects: Record<string, string[]> = {};
    const r = await buildCalendarFeedForToken(fakeSb(base(), selects), TOKEN, { now: NOW });
    expect(r.kind).toBe("ok");
    const body = (r as { body: string }).body.replace(/\r\n /g, "");
    expect(body).toContain("SUMMARY:Theatre 3 – Ortho");
    expect(body).toContain("Supervisor: Dr Super");
    // Sensitive free text is never requested nor rendered.
    expect(body).not.toMatch(/PRIVATE|TS NOTE/);
    for (const s of Object.values(selects).flat()) expect(s).not.toMatch(/\bnotes\b|\breason\b/);
  });

  for (const table of ["rota_assignments", "leave_requests", "theatre_sessions", "user_roles"]) {
    it(`503s when ${table} errors`, async () => {
      const t = base();
      t[table] = { data: null, error: { message: "boom" } };
      const r = await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW });
      expect(r.kind).toBe("unavailable");
    });
  }

  it("503s when the profile lookup errors", async () => {
    const t = base();
    t.profiles = { data: null, error: { message: "boom" } };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "unavailable",
    );
  });

  it("503s when a referenced theatre session is missing (no partial 200)", async () => {
    const t = base();
    t.theatre_sessions = { data: [], error: null };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "unavailable",
    );
  });

  it("503s when supervisor lookup errors or is missing", async () => {
    const t = base();
    t.profiles = (calls) =>
      calls.some((c) => c.m === "in")
        ? { data: [], error: null }
        : { data: { id: "u1", full_name: "Dr Test", active: true, left_at: null }, error: null };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "unavailable",
    );
  });

  it("includes every leave row across multiple 1,000-row pages", async () => {
    const t = base();
    const all = Array.from({ length: 2300 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 10, 3) + (i % 300) * 86_400_000).toISOString().slice(0, 10);
      return {
        id: `l${String(i).padStart(4, "0")}`,
        type: "annual",
        start_date: d,
        end_date: d,
        half_day_start: null,
        half_day_end: null,
        updated_at: null,
      };
    });
    t.leave_requests = (calls) => {
      const [a, b] = calls.find((c) => c.m === "range")?.a as number[];
      return { data: all.slice(a, b + 1), error: null };
    };
    const r = await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW });
    expect(r.kind).toBe("ok");
    const body = (r as { body: string }).body;
    for (const id of ["l0000", "l0999", "l1000", "l2299"]) expect(body).toContain(id);
  });

  it("503s when a second leave page errors", async () => {
    const t = base();
    t.leave_requests = (calls) => {
      const [a] = calls.find((c) => c.m === "range")?.a as number[];
      if (a === 0)
        return {
          data: Array.from({ length: 1000 }, (_, i) => ({
            id: `l${i}`,
            type: "annual",
            start_date: "2026-11-10",
            end_date: "2026-11-10",
            half_day_start: null,
            half_day_end: null,
            updated_at: null,
          })),
          error: null,
        };
      return { data: null, error: { message: "page 2" } };
    };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "unavailable",
    );
  });

  it("503s when a second page errors", async () => {
    const t = base();
    t.rota_assignments = (calls) => {
      const range = calls.find((c) => c.m === "range")?.a as number[];
      if (range[0] === 0)
        return {
          data: Array.from({ length: 1000 }, (_, i) => ({
            id: `r${i}`,
            session_date: "2026-11-02",
            session: "night",
            duty_type: "sho_oncall",
            role_on_list: null,
            updated_at: null,
            supervisor_id: null,
            theatre_session_id: null,
          })),
          error: null,
        };
      return { data: null, error: { message: "page 2" } };
    };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "unavailable",
    );
  });

  it.each([
    ["inactive", { active: false, left_at: null }],
    ["departed (left_at set)", { active: true, left_at: "2026-08-01" }],
  ])("denies the token of an %s member", async (_n, extra) => {
    const t = base();
    t.profiles = { data: { id: "u1", full_name: "X", ...extra }, error: null };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "not_found",
    );
  });

  it("denies a removed member (no roles)", async () => {
    const t = base();
    t.user_roles = { data: [], error: null };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "not_found",
    );
  });

  it("denies unknown/short/malformed tokens without querying", async () => {
    expect((await buildCalendarFeedForToken(fakeSb({}), "short", { now: NOW })).kind).toBe(
      "not_found",
    );
    expect(
      (await buildCalendarFeedForToken(fakeSb({}), "x".repeat(40) + "\r\n", { now: NOW })).kind,
    ).toBe("not_found");
    const t = base();
    t.profiles = { data: null, error: null };
    expect((await buildCalendarFeedForToken(fakeSb(t), TOKEN, { now: NOW })).kind).toBe(
      "not_found",
    );
  });
});

describe("calendar leave half days", () => {
  const L = (s: string, e: string, hs: string | null, he: string | null) => ({
    id: "l",
    type: "annual",
    start_date: s,
    end_date: e,
    half_day_start: hs,
    half_day_end: he,
    updated_at: null,
  });
  it("full days stay all-day", () => {
    expect(leaveEventTimes(L("2026-11-02", "2026-11-03", null, null))).toEqual([
      "DTSTART;VALUE=DATE:20261102",
      "DTEND;VALUE=DATE:20261104",
    ]);
  });
  it("single AM day is 08:00–13:00", () => {
    expect(leaveEventTimes(L("2026-11-02", "2026-11-02", null, "am"))).toEqual([
      "DTSTART;TZID=Europe/London:20261102T080000",
      "DTEND;TZID=Europe/London:20261102T130000",
    ]);
  });
  it("single PM day is 13:00–18:00", () => {
    expect(leaveEventTimes(L("2026-11-02", "2026-11-02", "pm", null))).toEqual([
      "DTSTART;TZID=Europe/London:20261102T130000",
      "DTEND;TZID=Europe/London:20261102T180000",
    ]);
  });
  it("PM start to AM end spans with the right boundaries", () => {
    expect(leaveEventTimes(L("2026-11-02", "2026-11-04", "pm", "am"))).toEqual([
      "DTSTART;TZID=Europe/London:20261102T130000",
      "DTEND;TZID=Europe/London:20261104T130000",
    ]);
  });
});

describe("ICS escaping and folding fixtures", () => {
  it("escapes every newline form, backslash, comma and semicolon; strips controls", () => {
    expect(escapeIcsText("a\r\nb\rc\nd\\e,f;g\u0007h")).toBe("a\\nb\\nc\\nd\\\\e\\,f\\;gh");
  });
  it("injected CRLF cannot start a new property", () => {
    const body = renderCalendarFeed({
      calendarName: "Evil\r\nATTENDEE:mailto:x@example.invalid",
      assignments: [],
      leave: [],
      theatreSessions: new Map(),
      supervisors: new Map(),
      now: NOW,
      host: "h",
    });
    expect(body.split("\r\n").some((l) => l.startsWith("ATTENDEE"))).toBe(false);
    expect(body.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
  it("folds at 75 UTF-8 octets without splitting multibyte characters", () => {
    const enc = new TextEncoder();
    for (const src of [
      "SUMMARY:" + "é".repeat(80),
      "SUMMARY:" + "🩺".repeat(40),
      "DESCRIPTION:" + "a".repeat(74) + "€€€",
      "X:" + "a".repeat(73),
    ]) {
      const folded = foldIcsLine(src);
      const parts = folded.split("\r\n");
      for (const p of parts) expect(enc.encode(p).byteLength).toBeLessThanOrEqual(75);
      for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
      // Unfolding restores the original exactly (no replacement chars).
      expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(src);
    }
  });
  it("lines of exactly 75 octets are not folded", () => {
    const l = "X:" + "a".repeat(73);
    expect(foldIcsLine(l)).toBe(l);
  });
});
