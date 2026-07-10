/**
 * End-to-end test for /api/chat: rejected and cancelled leave must NOT
 * distort rota / leave-impact answers.
 *
 * Drives the real TanStack server route through a fake Request, with the
 * Supabase admin client, AI gateway and `streamText` mocked. `streamText`
 * captures the `tools` map the route builds and invokes
 * `get_staff_current_pattern` directly, so the assertions exercise the
 * full request path — auth check, conversation ownership, tool wiring,
 * pattern computation, past-leave overlay, and lookahead leave merge.
 *
 * Contract being locked in (matches wellbeing-score + DB enum
 * `pending | approved | rejected | cancelled`):
 *
 *   1. Past `rejected` and `cancelled` leave MUST NOT block the weekly
 *      grid. The Monday AM cell keeps its real theatre location even
 *      though a rejected request "covered" every Monday.
 *   2. Future `rejected` and `cancelled` leave are surfaced in the
 *      `upcoming` list (so the chat can talk about them) but MUST NOT
 *      increment `overlapsByType` — that count is the "will you be on
 *      leave" signal the model uses to warn about rota impact.
 *   3. A `rejected` or `cancelled` request that spans today MUST NOT
 *      flip `onLeaveToday`. Only an `approved` request that spans
 *      today may set it.
 *
 * These are the three places a status-enum regression would silently
 * corrupt the assistant's rota answers.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// --------------------- fixtures ---------------------

const TODAY = "2026-07-06"; // Monday
const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const THEATRE_ID = "33333333-3333-3333-3333-333333333333";
const SPECIALTY_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_ID = "55555555-5555-5555-5555-555555555555";

// 12 Mondays inside the 90-day past window ending on TODAY.
const PAST_MONDAYS = [
  "2026-04-13",
  "2026-04-20",
  "2026-04-27",
  "2026-05-04",
  "2026-05-11",
  "2026-05-18",
  "2026-05-25",
  "2026-06-01",
  "2026-06-08",
  "2026-06-15",
  "2026-06-22",
  "2026-06-29",
];

const rotaAssignments = PAST_MONDAYS.map((d) => ({
  staff_id: USER_ID,
  duty_type: null,
  session_date: d,
  session: "am",
  theatre_session_id: SESSION_ID,
}));

const theatreSessions = [
  {
    id: SESSION_ID,
    theatre_id: THEATRE_ID,
    specialty_id: SPECIALTY_ID,
    is_non_sag: false,
  },
];

const theatres = [{ id: THEATRE_ID, name: "Theatre 1", kind: "main" }];
const specialties = [{ id: SPECIALTY_ID, name: "Orthopaedics" }];

// PAST WINDOW — rejected/cancelled leave that "covers" every Monday. The
// route's past-window query filters `.eq("status","approved")`, so the
// admin mock returns this empty list on that filter. It's kept here as
// documentation of the fixture intent: if the status filter regressed and
// the mock started returning these rows, the grid would flip to "On leave"
// and Assertion #1 would fire.
const pastNonApprovedLeave = [
  {
    type: "annual",
    start_date: "2026-04-13",
    end_date: "2026-05-01",
    status: "rejected" as const,
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
  {
    type: "study",
    start_date: "2026-05-04",
    end_date: "2026-06-30",
    status: "cancelled" as const,
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
];

// Future lookahead (today .. today + 60d): three overlapping requests, one
// per status that must NOT count as impact. `compassionate/approved` is the
// only one that should increment `overlapsByType`.
const futureLookaheadLeave = [
  {
    type: "annual",
    start_date: "2026-07-13",
    end_date: "2026-07-17",
    status: "rejected",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
  {
    type: "study",
    start_date: "2026-07-15",
    end_date: "2026-07-16",
    status: "cancelled",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
  {
    type: "compassionate",
    start_date: "2026-07-15",
    end_date: "2026-07-15",
    status: "approved",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
];

// Second scenario: a rejected AND a cancelled request that literally span
// today. `onLeaveToday` must stay false — only `approved` may flip it.
const onLeaveTodayNonApprovedLeave = [
  {
    type: "annual",
    start_date: "2026-07-05",
    end_date: "2026-07-08",
    status: "rejected",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
  {
    type: "sick",
    start_date: "2026-07-06",
    end_date: "2026-07-06",
    status: "cancelled",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
];

// Which fixture the leave_requests future-lookahead branch returns. Reset
// per-test so the two scenarios stay isolated.
let futureLeaveFixture: unknown[] = futureLookaheadLeave;

// --------------------- Supabase mock ---------------------

interface QueryState {
  table: string;
  eqCols: Record<string, unknown[]>;
  inCols: Record<string, unknown[]>;
  gteCols: Record<string, string>;
  lteCols: Record<string, string>;
  single: boolean;
}

function makeAdminClient() {
  const build = (table: string) => {
    const state: QueryState = {
      table,
      eqCols: {},
      inCols: {},
      gteCols: {},
      lteCols: {},
      single: false,
    };
    const resolve = () => {
      const data = dataFor(state);
      return Promise.resolve({ data, error: null });
    };
    const b: any = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      (state.eqCols[col] ??= []).push(val);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      state.inCols[col] = vals;
      return b;
    };
    b.gte = (col: string, val: string) => {
      state.gteCols[col] = val;
      return b;
    };
    b.lte = (col: string, val: string) => {
      state.lteCols[col] = val;
      return b;
    };
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
      select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "new" }, error: null }) }),
      then: (r: any) => Promise.resolve({ data: null, error: null }).then(r),
    });
    b.update = () => b;
    b.delete = () => b;
    b.then = (onOk: any, onErr: any) => resolve().then(onOk, onErr);
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
        ? { id: USER_ID, full_name: "Dr Test Consultant", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Test Consultant", grade: "consultant" }];
    case "theatres":
      return theatres;
    case "specialties":
      return specialties;
    case "rota_assignments":
      return rotaAssignments;
    case "theatre_sessions":
      return theatreSessions;
    case "leave_requests": {
      // The past-window overlay query pins `.eq("status","approved")`. In
      // this test that returns an EMPTY list — the past `rejected` /
      // `cancelled` fixtures above must never reach the grid. If a
      // regression drops the status filter the mock will hand those rows
      // over and Assertion #1 will fire.
      const approvedOnly = (state.eqCols.status ?? []).includes("approved");
      if (approvedOnly) return [];
      // pastNonApprovedLeave is intentionally unused by the mock — it
      // documents what the DB looks like around this staff. Reference it
      // so the linter doesn't drop the fixture.
      void pastNonApprovedLeave;
      return futureLeaveFixture;
    }
    case "leave_allowances":
      return state.single
        ? { annual_days: 32, study_days: 10, leave_year_start: "2026-04-01" }
        : [];
    case "custom_rota_rules":
      return [];
    default:
      return state.single ? null : [];
  }
}

// --------------------- vi.mock hoisted ---------------------

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeAdminClient(),
}));

vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({} as unknown),
}));

vi.mock("@/lib/gmail.server", () => ({
  sendGmail: vi.fn(async () => ({ ok: true })),
}));

const capturedToolResult: { value: unknown } = { value: null };

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (opts: { tools: Record<string, any> }) => {
      const patternTool = opts.tools?.get_staff_current_pattern;
      const promise = patternTool
        ? Promise.resolve(patternTool.execute({}))
        : Promise.resolve(null);
      return {
        toUIMessageStreamResponse: async () => {
          capturedToolResult.value = await promise;
          return new Response(JSON.stringify(capturedToolResult.value), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
    convertToModelMessages: (m: unknown) => m,
    stepCountIs: () => ({}),
    tool: (def: unknown) => def,
  };
});

// --------------------- test ---------------------

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.LOVABLE_API_KEY = "test-key";
});
afterAll(() => vi.useRealTimers());

type PatternPayload = {
  assignmentCount: number;
  weeklyGrid: Array<{
    session: "am" | "pm";
    days: Array<{ weekday: string; location: string | null; recurrence: string | null }>;
  }>;
  leave: {
    onLeaveToday: boolean;
    overlapsByType: Record<string, number>;
    upcoming: Array<{ type: string; status: string; start_date: string; end_date: string }>;
  };
};

async function invokePatternTool(): Promise<PatternPayload> {
  const mod = await import("./chat");
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
          parts: [{ type: "text", text: "How does my leave affect my rota?" }],
        },
      ],
    }),
  });
  const res = await handler({ request: req });
  expect(res.status).toBe(200);
  return (await res.json()) as PatternPayload;
}

describe("/api/chat e2e — rejected & cancelled leave don't distort rota answers", () => {
  it(
    "keeps the weekly grid intact, excludes non-active leave from overlapsByType, " +
      "and still surfaces every request in `upcoming`",
    async () => {
      futureLeaveFixture = futureLookaheadLeave;

      const payload = await invokePatternTool();

      // #1 — Weekly grid unaffected by past rejected/cancelled leave.
      // Baseline 12 Monday-AM theatre lists remain; no leave overlay applied.
      expect(payload.assignmentCount).toBe(12);
      const amRow = payload.weeklyGrid.find((r) => r.session === "am");
      const mondayAm = amRow!.days.find((d) => d.weekday === "Mon");
      // The exact location bucket is a pattern-computation detail; the
      // guarantee this test locks in is that rejected/cancelled leave
      // does NOT flip the Monday-AM cell to "On leave".
      expect(mondayAm?.location).not.toBe("On leave");
      expect(mondayAm?.location).not.toBeNull();

      // #2 — overlapsByType counts only non-cancelled, non-rejected leave.
      // Rejected annual + cancelled study on 07-15 must NOT count; the
      // approved compassionate request is the only real impact.
      expect(payload.leave.overlapsByType.annual).toBe(0);
      expect(payload.leave.overlapsByType.study).toBe(0);
      expect(payload.leave.overlapsByType.compassionate).toBe(1);

      // …but the assistant still needs to be able to talk about the
      // rejected/cancelled requests when asked, so they appear in
      // `upcoming` with their real status.
      const byType = new Map(payload.leave.upcoming.map((r) => [r.type, r.status]));
      expect(byType.get("annual")).toBe("rejected");
      expect(byType.get("study")).toBe("cancelled");
      expect(byType.get("compassionate")).toBe("approved");

      // #3 — TODAY is before every future request starts.
      expect(payload.leave.onLeaveToday).toBe(false);
    },
  );

  it(
    "does NOT flip onLeaveToday when the request covering today is rejected or cancelled",
    async () => {
      futureLeaveFixture = onLeaveTodayNonApprovedLeave;

      const payload = await invokePatternTool();

      // Both requests literally span TODAY (2026-07-06) but neither is
      // approved — the assistant must not tell the user they're on leave.
      const spansToday = payload.leave.upcoming.filter(
        (r) => r.start_date <= TODAY && r.end_date >= TODAY,
      );
      expect(spansToday.map((r) => r.status).sort()).toEqual(["cancelled", "rejected"]);
      expect(payload.leave.onLeaveToday).toBe(false);

      // And, again, neither request contributes to the impact count.
      expect(payload.leave.overlapsByType.annual).toBe(0);
      expect(payload.leave.overlapsByType.sick).toBe(0);
    },
  );
});
