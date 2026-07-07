/**
 * End-to-end test for the /api/chat POST handler with a half-day leave
 * that spans a week boundary (Fri PM → Mon AM).
 *
 * Baseline: 3 consecutive weeks each with theatre lists on Friday AND
 * Monday, in both AM and PM. Each week carries an approved leave
 * request starting Fri with `half_day_start = 'pm'` and ending Mon with
 * `half_day_end = 'am'` — Fri AM and Mon PM must stay as theatre, while
 * Fri PM and Mon AM flip to "On leave" through Sat/Sun.
 *
 * Expected weeklyGrid outcomes:
 *   - Fri AM = "Main theatres" 3/3
 *   - Fri PM = "On leave"      3/3
 *   - Mon AM = "On leave"      3/3
 *   - Mon PM = "Main theatres" 3/3
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const TODAY = "2026-07-06"; // Monday
const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const THEATRE_ID = "33333333-3333-3333-3333-333333333333";
const SPECIALTY_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_ID = "55555555-5555-5555-5555-555555555555";

// Three Fri→Mon spans, all inside the 90-day window ending on TODAY.
const SPANS = [
  { fri: "2026-06-12", mon: "2026-06-15" },
  { fri: "2026-06-19", mon: "2026-06-22" },
  { fri: "2026-06-26", mon: "2026-06-29" },
];

const rotaAssignments = SPANS.flatMap(({ fri, mon }) => [
  { staff_id: USER_ID, duty_type: "theatre", session_date: fri, session: "am", theatre_session_id: SESSION_ID },
  { staff_id: USER_ID, duty_type: "theatre", session_date: fri, session: "pm", theatre_session_id: SESSION_ID },
  { staff_id: USER_ID, duty_type: "theatre", session_date: mon, session: "am", theatre_session_id: SESSION_ID },
  { staff_id: USER_ID, duty_type: "theatre", session_date: mon, session: "pm", theatre_session_id: SESSION_ID },
]);

const theatreSessions = [
  { id: SESSION_ID, theatre_id: THEATRE_ID, specialty_id: SPECIALTY_ID, is_non_sag: false },
];
const theatres = [{ id: THEATRE_ID, name: "Theatre 1", kind: "main" }];
const specialties = [{ id: SPECIALTY_ID, name: "Orthopaedics" }];

const pastApprovedLeave = SPANS.map(({ fri, mon }) => ({
  type: "annual" as const,
  start_date: fri,
  end_date: mon,
  status: "approved" as const,
  half_day_start: "pm" as const,
  half_day_end: "am" as const,
  reason: null,
  decision_notes: null,
}));

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
    const resolve = () => Promise.resolve({ data: dataFor(state), error: null });
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
      return state.single ? { id: CONVERSATION_ID, user_id: USER_ID, title: "Chat" } : [];
    case "ai_messages":
      return [];
    case "user_roles":
      return state.single ? null : [];
    case "profiles":
      return state.single
        ? { id: USER_ID, full_name: "Dr Weekboundary", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Weekboundary", grade: "consultant" }];
    case "theatres":
      return theatres;
    case "specialties":
      return specialties;
    case "rota_assignments":
      return rotaAssignments;
    case "theatre_sessions":
      return theatreSessions;
    case "leave_requests": {
      const approvedOnly = (state.eqCols.status ?? []).includes("approved");
      return approvedOnly ? pastApprovedLeave : [];
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

async function invokePost(body: unknown): Promise<Response> {
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

describe("/api/chat e2e — half-day leave spanning a week boundary", () => {
  it("flips Fri PM and Mon AM to 'On leave' while Fri AM and Mon PM stay 'Main theatres'", async () => {
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
      windowDays: number;
      assignmentCount: number;
      weeklyGrid: Array<{
        session: "am" | "pm";
        days: Array<{ weekday: string; location: string | null; recurrence: string | null }>;
      }>;
    };

    expect(payload.windowDays).toBe(90);

    // Effective assignments per span: Fri AM theatre + Fri PM leave +
    // Sat AM/PM leave + Sun AM/PM leave + Mon AM leave + Mon PM theatre
    // = 8 per week × 3 weeks = 24 total.
    expect(payload.assignmentCount).toBe(24);

    const amRow = payload.weeklyGrid.find((r) => r.session === "am")!;
    const pmRow = payload.weeklyGrid.find((r) => r.session === "pm")!;

    const friAm = amRow.days.find((d) => d.weekday === "Fri")!;
    const friPm = pmRow.days.find((d) => d.weekday === "Fri")!;
    const monAm = amRow.days.find((d) => d.weekday === "Mon")!;
    const monPm = pmRow.days.find((d) => d.weekday === "Mon")!;

    expect(friAm.location).toBe("Main theatres");
    expect(friAm.recurrence).toBe("3/3");
    expect(friPm.location).toBe("On leave");
    expect(friPm.recurrence).toBe("3/3");

    expect(monAm.location).toBe("On leave");
    expect(monAm.recurrence).toBe("3/3");
    expect(monPm.location).toBe("Main theatres");
    expect(monPm.recurrence).toBe("3/3");
  });
});
