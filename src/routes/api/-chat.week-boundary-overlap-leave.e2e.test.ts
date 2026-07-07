/**
 * End-to-end test for the /api/chat POST handler with TWO overlapping
 * half-day leave requests that together span a week boundary.
 *
 * For each of 3 consecutive Fri→Mon windows we approve:
 *   - Leave A: Fri (half_day_start='pm') → Mon (no end half)
 *              → covers Fri PM, Sat AM/PM, Sun AM/PM, Mon AM, Mon PM
 *   - Leave B: Fri (no start half)      → Mon (half_day_end='am')
 *              → covers Fri AM, Fri PM, Sat/Sun AM+PM, Mon AM
 *
 * The two overlap on Fri PM, Sat, Sun, and Mon AM. Together they cover
 * every half-session from Fri AM through Mon PM, so the dominant label
 * per half-session should be "On leave" for BOTH Fri AM/PM and Mon
 * AM/PM — 3/3 across the 3 weeks — despite the overlap.
 *
 * Baseline rota has theatre lists on Fri AM/PM and Mon AM/PM for each
 * of the 3 weeks; leave must fully mask them in the weeklyGrid.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const TODAY = "2026-07-06"; // Monday
const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const THEATRE_ID = "33333333-3333-3333-3333-333333333333";
const SPECIALTY_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_ID = "55555555-5555-5555-5555-555555555555";

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

// Two overlapping approved leaves per span.
const pastApprovedLeave = SPANS.flatMap(({ fri, mon }) => [
  {
    type: "annual" as const,
    start_date: fri,
    end_date: mon,
    status: "approved" as const,
    half_day_start: "pm" as const,
    half_day_end: null,
    reason: null,
    decision_notes: null,
  },
  {
    type: "annual" as const,
    start_date: fri,
    end_date: mon,
    status: "approved" as const,
    half_day_start: null,
    half_day_end: "am" as const,
    reason: null,
    decision_notes: null,
  },
]);

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
        ? { id: USER_ID, full_name: "Dr Overlap", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Overlap", grade: "consultant" }];
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

describe("/api/chat e2e — two overlapping half-day leaves spanning a week boundary", () => {
  it("keeps 'On leave' as dominant on Fri AM/PM and Mon AM/PM despite overlap", async () => {
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

    // Union of the two overlapping leaves per week covers every half from
    // Fri AM through Mon PM inclusive = 8 halves × 3 weeks = 24 leave
    // assignments. Overlap must not double-count.
    expect(payload.assignmentCount).toBe(24);

    const amRow = payload.weeklyGrid.find((r) => r.session === "am")!;
    const pmRow = payload.weeklyGrid.find((r) => r.session === "pm")!;

    for (const day of ["Fri", "Mon"] as const) {
      const am = amRow.days.find((d) => d.weekday === day)!;
      const pm = pmRow.days.find((d) => d.weekday === day)!;
      expect(am.location).toBe("On leave");
      expect(am.recurrence).toBe("3/3");
      expect(pm.location).toBe("On leave");
      expect(pm.recurrence).toBe("3/3");
    }
  });
});
