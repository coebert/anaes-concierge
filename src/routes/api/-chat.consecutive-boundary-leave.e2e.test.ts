/**
 * End-to-end test for the /api/chat POST handler with THREE consecutive
 * Fri-PM → Mon-AM half-day leave requests, back-to-back across four
 * work-weeks in the 90-day window.
 *
 *   Wk1: Mon 2026-06-01 .. Fri 2026-06-05
 *   Wk2: Mon 2026-06-08 .. Fri 2026-06-12
 *   Wk3: Mon 2026-06-15 .. Fri 2026-06-19
 *   Wk4: Mon 2026-06-22 .. Fri 2026-06-26
 *
 * Boundary spans (each `half_day_start='pm'`, `half_day_end='am'`):
 *   A: Fri 2026-06-05 → Mon 2026-06-08
 *   B: Fri 2026-06-12 → Mon 2026-06-15
 *   C: Fri 2026-06-19 → Mon 2026-06-22
 *
 * Effect on the weeklyGrid (dominant-per-weekday-half over 4 weeks):
 *   - Fri PM  → 3× leave, 1× theatre → dominant "On leave" 3/4
 *   - Mon AM  → 1× theatre, 3× leave → dominant "On leave" 3/4
 *   - Fri AM  → 4× theatre           → "Main theatres" 4/4
 *   - Mon PM  → 4× theatre           → "Main theatres" 4/4
 *   - Tue/Wed/Thu AM & PM → 4× theatre each → "Main theatres" 4/4
 *
 * The point: consecutive week boundaries must produce a SINGLE consistent
 * label per weekday-half — no oscillation, no half-session left uncovered.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const TODAY = "2026-07-06"; // Monday
const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const THEATRE_ID = "33333333-3333-3333-3333-333333333333";
const SPECIALTY_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_ID = "55555555-5555-5555-5555-555555555555";

const WEEKS = [
  { mon: "2026-06-01", tue: "2026-06-02", wed: "2026-06-03", thu: "2026-06-04", fri: "2026-06-05" },
  { mon: "2026-06-08", tue: "2026-06-09", wed: "2026-06-10", thu: "2026-06-11", fri: "2026-06-12" },
  { mon: "2026-06-15", tue: "2026-06-16", wed: "2026-06-17", thu: "2026-06-18", fri: "2026-06-19" },
  { mon: "2026-06-22", tue: "2026-06-23", wed: "2026-06-24", thu: "2026-06-25", fri: "2026-06-26" },
];

const rotaAssignments = WEEKS.flatMap((w) =>
  [w.mon, w.tue, w.wed, w.thu, w.fri].flatMap((d) => [
    { staff_id: USER_ID, duty_type: "theatre", session_date: d, session: "am", theatre_session_id: SESSION_ID },
    { staff_id: USER_ID, duty_type: "theatre", session_date: d, session: "pm", theatre_session_id: SESSION_ID },
  ]),
);

const theatreSessions = [
  { id: SESSION_ID, theatre_id: THEATRE_ID, specialty_id: SPECIALTY_ID, is_non_sag: false },
];
const theatres = [{ id: THEATRE_ID, name: "Theatre 1", kind: "main" }];
const specialties = [{ id: SPECIALTY_ID, name: "Orthopaedics" }];

// Three consecutive Fri-PM → Mon-AM half-day boundary leaves.
const BOUNDARIES = [
  { fri: WEEKS[0].fri, mon: WEEKS[1].mon }, // A
  { fri: WEEKS[1].fri, mon: WEEKS[2].mon }, // B
  { fri: WEEKS[2].fri, mon: WEEKS[3].mon }, // C
];

const pastApprovedLeave = BOUNDARIES.map(({ fri, mon }) => ({
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
        ? { id: USER_ID, full_name: "Dr Consecutive", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Consecutive", grade: "consultant" }];
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

describe("/api/chat e2e — consecutive Fri-PM → Mon-AM boundaries across weeks", () => {
  it("gives a single consistent label per weekday-half across all 4 weeks", async () => {
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
      weeklyGrid: Array<{
        session: "am" | "pm";
        days: Array<{ weekday: string; location: string | null; recurrence: string | null }>;
      }>;
    };
    expect(payload.windowDays).toBe(90);

    const amRow = payload.weeklyGrid.find((r) => r.session === "am")!;
    const pmRow = payload.weeklyGrid.find((r) => r.session === "pm")!;

    const cell = (session: "am" | "pm", weekday: string) => {
      const row = session === "am" ? amRow : pmRow;
      const c = row.days.find((d) => d.weekday === weekday);
      if (!c) throw new Error(`missing cell ${weekday} ${session}`);
      return c;
    };

    // Boundary halves flip to leave 3/4.
    const monAm = cell("am", "Mon");
    expect(monAm.location).toBe("On leave");
    expect(monAm.recurrence).toBe("3/4");

    const friPm = cell("pm", "Fri");
    expect(friPm.location).toBe("On leave");
    expect(friPm.recurrence).toBe("3/4");

    // Preserved halves stay Main theatres 4/4.
    for (const [day, sess] of [
      ["Mon", "pm"],
      ["Fri", "am"],
    ] as const) {
      const c = cell(sess, day);
      expect(c.location, `${day} ${sess}`).toBe("Main theatres");
      expect(c.recurrence, `${day} ${sess} recurrence`).toBe("4/4");
    }

    // Interior weekdays are untouched — theatre both halves, every week.
    for (const day of ["Tue", "Wed", "Thu"] as const) {
      for (const sess of ["am", "pm"] as const) {
        const c = cell(sess, day);
        expect(c.location, `${day} ${sess}`).toBe("Main theatres");
        expect(c.recurrence, `${day} ${sess} recurrence`).toBe("4/4");
      }
    }
  });
});
