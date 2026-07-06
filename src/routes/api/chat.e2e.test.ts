/**
 * End-to-end test for the /api/chat POST handler.
 *
 * Drives the real TanStack server route through a fake Request, with the
 * Supabase admin client, AI gateway, gmail sender, and `streamText` mocked.
 * The mocked `streamText` captures the `tools` map the route builds and
 * invokes `get_staff_current_pattern` directly, so we exercise the full
 * request path — auth check, conversation ownership check, tool wiring,
 * pattern computation, leave overlay and leave availability merge — end
 * to end, and assert on the tool's returned shape.
 *
 * Scenario:
 *   - windowDays = 90 (default). Window = 2026-04-07 .. 2026-07-06.
 *   - Baseline: 12 Monday-AM theatre lists (Orthopaedics) in the window.
 *   - Approved past leave OVERLAPPING three types (annual + study +
 *     compassionate) blocks 10 of those 12 Mondays, so the dominant
 *     bucket for Monday AM flips from "Main theatres" to "On leave".
 *   - Future lookahead (60d) contains three overlapping requests —
 *     annual (approved), study (pending) and compassionate (approved)
 *     covering 2026-07-15 — so `overlapsByType` surfaces one of each.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// --------------------- fixtures ---------------------

const TODAY = "2026-07-06"; // Monday
const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const THEATRE_ID = "33333333-3333-3333-3333-333333333333";
const SPECIALTY_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_ID = "55555555-5555-5555-5555-555555555555";

// 12 Mondays inside the 90-day past window ending on TODAY (2026-07-06).
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

// Approved past leave — three overlapping types blocking 10/12 Mondays.
const pastApprovedLeave = [
  { type: "annual", start_date: "2026-04-13", end_date: "2026-05-01" }, // 04-13, 04-20, 04-27
  { type: "compassionate", start_date: "2026-05-04", end_date: "2026-05-08" }, // 05-04
  { type: "study", start_date: "2026-05-11", end_date: "2026-05-15" }, // 05-11
  { type: "annual", start_date: "2026-05-18", end_date: "2026-06-05" }, // 05-18, 05-25, 06-01
  { type: "study", start_date: "2026-06-08", end_date: "2026-06-12" }, // 06-08
  { type: "compassionate", start_date: "2026-06-15", end_date: "2026-06-19" }, // 06-15
].map((r) => ({
  ...r,
  status: "approved" as const,
  half_day_start: null,
  half_day_end: null,
  reason: null,
  decision_notes: null,
}));

// Future lookahead leave (today .. today + 60d) — same three types
// overlapping on 2026-07-15.
const futureLookaheadLeave = [
  {
    type: "annual",
    start_date: "2026-07-13",
    end_date: "2026-07-17",
    status: "approved",
    half_day_start: null,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
  {
    type: "study",
    start_date: "2026-07-15",
    end_date: "2026-07-16",
    status: "pending",
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
      // Non-admin, non-coordinator user (so tool defaults to self).
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
      // The overlay query filters .eq("status","approved"); the tool's
      // lookahead query does not.
      const approvedOnly = (state.eqCols.status ?? []).includes("approved");
      return approvedOnly ? pastApprovedLeave : futureLookaheadLeave;
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

// Capture the tools the route builds, and drive `get_staff_current_pattern`
// directly. Return a Response object whose body is the tool result — the
// test reads that back off the Response returned by the POST handler.
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

async function invokePost(body: unknown): Promise<Response> {
  // Import lazily so the vi.mock hoists apply before route module load.
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
    body: JSON.stringify(body),
  });
  return handler({ request: req });
}

describe("/api/chat e2e — get_staff_current_pattern with overlapping leave", () => {
  it("returns dominant 'On leave' for Monday AM and surfaces annual/study/compassionate overlaps", async () => {
    const res = await invokePost({
      conversationId: CONVERSATION_ID,
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "What's my current pattern?" }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      profile: { full_name: string; grade: string };
      windowDays: number;
      assignmentCount: number;
      weeklyGrid: Array<{
        session: "am" | "pm";
        days: Array<{ weekday: string; location: string | null; recurrence: string | null }>;
      }>;
      leave: {
        onLeaveToday: boolean;
        overlapsByType: Record<string, number>;
        upcoming: Array<{ type: string; status: string }>;
      };
    };

    // Profile & window plumbed through.
    expect(payload.profile.grade).toBe("consultant");
    expect(payload.windowDays).toBe(90);

    // 12 baseline theatre rows + 10 overlay leave rows = 22 effective assignments.
    // (Two Mondays remain uncovered by leave.)
    expect(payload.assignmentCount).toBe(22);

    // AM row, Monday cell = "On leave" with 10/12 recurrence.
    const amRow = payload.weeklyGrid.find((r) => r.session === "am");
    expect(amRow).toBeDefined();
    const mondayAm = amRow!.days.find((d) => d.weekday === "Mon");
    expect(mondayAm?.location).toBe("On leave");
    expect(mondayAm?.recurrence).toBe("10/12");

    // Overlap counts include one of each type.
    expect(payload.leave.overlapsByType.annual).toBe(1);
    expect(payload.leave.overlapsByType.study).toBe(1);
    expect(payload.leave.overlapsByType.compassionate).toBe(1);

    // Every future request is surfaced, including the pending study leave
    // that overlaps the approved annual + compassionate ones.
    const types = payload.leave.upcoming.map((r) => r.type).sort();
    expect(types).toEqual(["annual", "compassionate", "study"]);
    const study = payload.leave.upcoming.find((r) => r.type === "study");
    expect(study?.status).toBe("pending");

    // Today (2026-07-06) is before every future leave starts.
    expect(payload.leave.onLeaveToday).toBe(false);
  });

  it("rejects unauthenticated requests", async () => {
    const mod = await import("./chat");
    const handler = (mod.Route as any).options.server.handlers.POST as (ctx: {
      request: Request;
    }) => Promise<Response>;
    const req = new Request("http://x/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: CONVERSATION_ID,
        messages: [{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    const res = await handler({ request: req });
    expect(res.status).toBe(401);
  });
});
