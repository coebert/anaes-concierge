/**
 * Integration regression for /api/chat's `get_my_wellbeing_score` tool:
 * the SERVER-SIDE wellbeing calculation must apply the SAME timezone
 * normalisation to stored `decided_at` values as the frontend engine —
 * i.e. anchor on `decided_at.slice(0, 10)` (the wall-clock day encoded
 * in the ISO string), not on the UTC-normalised day.
 *
 * Contract locked in by this test:
 *
 *   1. Rows with different zone suffixes on `decided_at` (Z, +HH:MM,
 *      -HH:MM, +14:00 extreme, half-hour +05:30) are counted by their
 *      LOCAL wall-clock day — regardless of what the UTC-equivalent day
 *      would be. A row whose UTC-equivalent is out-of-window but whose
 *      wall-clock day is in-window MUST count; a row whose
 *      UTC-equivalent is in-window but whose wall-clock day is
 *      out-of-window MUST NOT count.
 *   2. The backend's returned `leave` driver value is byte-equal to a
 *      reference `computeWellbeing(...)` call on the identical rows.
 *   3. The assistant reply text embeds the same driver label
 *      (`"N rejected/cancelled leave"`) that the reference produced.
 *
 * A regression that UTC-normalises `decided_at` (e.g. `new
 * Date(decided_at).toISOString().slice(0,10)`) would silently flip
 * counts by exactly the number of rows whose zone suffix straddles UTC
 * midnight. This test asserts the count against a reference computed
 * with the intended semantics, so any such drift shows up as a hard
 * numeric mismatch — not a soft "the reply changed a bit" signal.
 *
 * Sister coverage:
 *   - `src/lib/wellbeing-score-decided-at-timezone.test.ts` — unit-level
 *     coverage of the same string-slice semantics against
 *     `computeWellbeing` directly.
 *   - `src/routes/api/-chat.wellbeing-response-changes-after-leave-decision.e2e.test.ts`
 *     — end-to-end that the chat reply changes when leave is cancelled
 *     / rejected today (decided_at anchoring, without timezone stress).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

import {
  computeWellbeing,
  type LeaveLite,
} from "@/features/wellbeing/wellbeing-score";

// --------------------- fixtures ---------------------

// Pin NOW so the 90-day window is deterministic. With NOW =
// 2026-07-06T12:00:00Z, `computeWellbeing`'s window (start = NOW -
// 90d, end = NOW) has these calendar-day boundaries via `parseDay`:
//   parseDay("2026-04-07") = 2026-04-07T00:00Z  →  BEFORE windowStart (2026-04-07T12:00Z)  →  OUT
//   parseDay("2026-04-08") = 2026-04-08T00:00Z  →  inside window  →  IN
//   parseDay("2026-07-06") = 2026-07-06T00:00Z  →  inside window  →  IN
//   parseDay("2026-07-07") = 2026-07-07T00:00Z  →  AFTER now  →  OUT
const TODAY = "2026-07-06";
const NOW = new Date(`${TODAY}T12:00:00Z`);
const FIRST_IN = "2026-04-08";
const LAST_IN = "2026-07-06";
const OUT_BEFORE = "2026-04-07";
const OUT_AFTER = "2026-07-07";
const MID_IN = "2026-05-01";

const USER_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CONVERSATION_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

type LeaveRow = {
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  decided_at: string | null;
  half_day_start: boolean | null;
  half_day_end: boolean | null;
};

let leaveFixture: LeaveRow[] = [];

// --------------------- Supabase mock ---------------------

interface QueryState {
  table: string;
  eqCols: Record<string, unknown[]>;
  neqCols: Record<string, unknown[]>;
  single: boolean;
}

function makeAdminClient() {
  const build = (table: string) => {
    const state: QueryState = { table, eqCols: {}, neqCols: {}, single: false };
    const resolve = () =>
      Promise.resolve({ data: dataFor(state), error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      (state.eqCols[col] ??= []).push(val);
      return b;
    };
    b.neq = (col: string, val: unknown) => {
      (state.neqCols[col] ??= []).push(val);
      return b;
    };
    b.in = () => b;
    b.gte = () => b;
    b.lte = () => b;
    b.range = () => b;
    b.limit = () => b;
    b.order = () => b;
    b.or = () => b;
    b.maybeSingle = () => {
      state.single = true;
      return b;
    };
    b.single = b.maybeSingle;
    b.insert = () => ({
      select: () => ({
        maybeSingle: () =>
          Promise.resolve({ data: { id: "new" }, error: null }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (r: any) =>
        Promise.resolve({ data: null, error: null }).then(r),
    });
    b.update = () => b;
    b.delete = () => b;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (ok: any, err: any) => resolve().then(ok, err);
    return b;
  };
  return {
    from: (t: string) => build(t),
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
  };
}

function dataFor(state: QueryState): unknown {
  switch (state.table) {
    case "ai_conversations":
      return state.single
        ? { id: CONVERSATION_ID, user_id: USER_ID, title: "Chat" }
        : [];
    case "ai_messages":
      return [];
    case "user_roles":
      return state.single ? null : [];
    case "profiles":
      return state.single
        ? { id: USER_ID, full_name: "Dr Test", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Test", grade: "consultant" }];
    case "leave_requests":
      return leaveFixture;
    case "leave_allowances":
      return state.single
        ? { annual_days: 32, study_days: 10, leave_year_start: "2026-04-01" }
        : [];
    default:
      return state.single ? null : [];
  }
}

// --------------------- vi.mock hoisted ---------------------

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeAdminClient(),
}));
vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({}) as unknown,
}));
vi.mock("@/lib/gmail.server", () => ({
  sendGmail: vi.fn(async () => ({ ok: true })),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamText: (opts: { tools: Record<string, any> }) => {
      return {
        toUIMessageStreamResponse: async () => {
          const wb = opts.tools?.get_my_wellbeing_score;
          const tool = wb ? await wb.execute({}) : null;
          const leaveDriver = tool?.drivers?.find(
            (d: { key: string }) => d.key === "leave",
          );
          const reply = tool
            ? `Your wellbeing score is ${tool.score} (${tool.band_label}). ` +
              `Leave signal: ${leaveDriver?.label ?? "n/a"}.`
            : "No wellbeing data available.";
          return new Response(
            JSON.stringify({ assistantText: reply, tool }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      };
    },
    convertToModelMessages: (m: unknown) => m,
    stepCountIs: () => ({}),
    tool: (def: unknown) => def,
  };
});

// --------------------- lifecycle ---------------------

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.LOVABLE_API_KEY = "test-key";
});
afterAll(() => vi.useRealTimers());

// --------------------- helpers ---------------------

async function askChat(): Promise<{
  assistantText: string;
  tool: {
    score: number;
    drivers: Array<{
      key: string;
      value: number;
      label: string;
      impact: number;
    }>;
    windowStart: string;
    windowEnd: string;
  };
}> {
  const mod = await import("./chat");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (mod.Route as any).options.server.handlers.POST as (ctx: {
    request: Request;
  }) => Promise<Response>;
  const req = new Request("http://x/api/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      conversationId: CONVERSATION_ID,
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "What is my wellbeing score right now?" }],
        },
      ],
    }),
  });
  const res = await handler({ request: req });
  expect(res.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await res.json()) as any;
}

function referenceLeaveCount(rows: LeaveRow[]): number {
  const lite: LeaveLite[] = rows.map((r) => ({
    staff_id: r.staff_id,
    status: r.status,
    type: r.type,
    start_date: r.start_date,
    end_date: r.end_date,
    decided_at: r.decided_at,
  }));
  const res = computeWellbeing({
    staffId: USER_ID,
    now: NOW,
    windowDays: 90,
    assignments: [],
    changes: [],
    leave: lite,
    exceptions: [],
  });
  const d = res.drivers.find((x) => x.key === "leave");
  if (!d) throw new Error("leave driver missing");
  return d.value;
}

function row(status: "cancelled" | "rejected", decided_at: string): LeaveRow {
  return {
    staff_id: USER_ID,
    type: "annual",
    // start_date parked far outside the window so ONLY decided_at can
    // bring a row in — proves anchor is decided_at, not start_date.
    start_date: "2000-01-01",
    end_date: "2000-01-01",
    status,
    decided_at,
    half_day_start: null,
    half_day_end: null,
  };
}

// --------------------- tests ---------------------

describe("/api/chat integration — backend applies wall-clock timezone normalisation to decided_at", () => {
  it(
    "counts decided_at rows by their LOCAL wall-clock day across mixed " +
      "timezone suffixes — matches the reference computeWellbeing engine byte-for-byte",
    async () => {
      // Fixture chosen so every row's wall-clock day and UTC-equivalent
      // day DISAGREE on window membership — a regression that
      // UTC-normalises `decided_at` before slicing would flip each of
      // these counts.
      leaveFixture = [
        // WALL-CLOCK IN, UTC OUT — must COUNT.
        // 02:00+11:00 on FIRST_IN → UTC 2026-04-07T15:00Z (day OUT).
        row("cancelled", `${FIRST_IN}T02:00:00+11:00`),
        // WALL-CLOCK OUT, UTC IN — must NOT COUNT.
        // 23:30-10:00 on OUT_BEFORE → UTC 2026-04-08T09:30Z (day IN).
        row("rejected", `${OUT_BEFORE}T23:30:00-10:00`),
        // WALL-CLOCK IN (LAST_IN), late UTC — must COUNT.
        row("cancelled", `${LAST_IN}T23:59:59.999Z`),
        // WALL-CLOCK OUT (OUT_AFTER), UTC IN via +14:00 — must NOT COUNT.
        // 01:00+14:00 on OUT_AFTER → UTC 2026-07-06T11:00Z (day IN).
        row("rejected", `${OUT_AFTER}T01:00:00+14:00`),
        // Half-hour offset, wall-clock IN → COUNT.
        row("cancelled", `${MID_IN}T23:59:59+05:30`),
        // Bare-date decided_at (no time part), wall-clock IN → COUNT.
        row("rejected", MID_IN),
      ];

      // Expected wall-clock in-window rows: 4 (rows 0, 2, 4, 5).
      // Reference is the source of truth — if this ever changes the
      // whole test recalibrates in one place.
      const expected = referenceLeaveCount(leaveFixture);
      expect(
        expected,
        "sanity: reference must count 4 wall-clock in-window rows",
      ).toBe(4);

      const reply = await askChat();
      const leaveDriver = reply.tool.drivers.find((d) => d.key === "leave")!;

      // (2) Backend value is byte-equal to the reference.
      expect(leaveDriver.value).toBe(expected);
      expect(leaveDriver.label).toBe(`${expected} rejected/cancelled leave`);

      // (3) Assistant reply embeds the same driver label.
      expect(reply.assistantText).toContain(
        `${expected} rejected/cancelled leave`,
      );
    },
  );

  it(
    "does not count a row whose wall-clock day is out-of-window even if the " +
      "UTC-equivalent falls inside — isolates the boundary flip on ONE row",
    async () => {
      // A single row: wall-clock day = OUT_BEFORE (outside), UTC-day =
      // FIRST_IN (inside). A UTC-normalising regression would count 1.
      leaveFixture = [row("rejected", `${OUT_BEFORE}T23:30:00-10:00`)];

      const expected = referenceLeaveCount(leaveFixture);
      expect(expected).toBe(0);

      const reply = await askChat();
      const leaveDriver = reply.tool.drivers.find((d) => d.key === "leave")!;
      expect(leaveDriver.value).toBe(0);
      expect(leaveDriver.label).toBe("0 rejected/cancelled leave");
    },
  );

  it(
    "counts a row whose wall-clock day is in-window even if the UTC-equivalent " +
      "falls outside — the symmetric boundary flip on ONE row",
    async () => {
      // Wall-clock day = FIRST_IN (inside), UTC-day = OUT_BEFORE
      // (outside via +11:00). A UTC-normalising regression would count 0.
      leaveFixture = [row("cancelled", `${FIRST_IN}T02:00:00+11:00`)];

      const expected = referenceLeaveCount(leaveFixture);
      expect(expected).toBe(1);

      const reply = await askChat();
      const leaveDriver = reply.tool.drivers.find((d) => d.key === "leave")!;
      expect(leaveDriver.value).toBe(1);
      expect(leaveDriver.label).toBe("1 rejected/cancelled leave");
    },
  );
});
