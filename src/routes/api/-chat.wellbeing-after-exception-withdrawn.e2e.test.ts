/**
 * End-to-end test for /api/chat: withdrawing an exception report (or
 * flipping its status to `withdrawn`) must NOT perturb the tool payloads
 * the assistant uses to answer wellbeing / rota-impact questions.
 *
 * Rationale
 * ---------
 * The chat route does not (currently) expose an exception-reports tool.
 * Its wellbeing/rota surface is:
 *   - get_my_upcoming_rota      (rota_assignments)
 *   - get_my_leave_summary      (leave_requests + leave_allowances)
 *   - get_staff_current_pattern (rota + leave, via computeCurrentPatternForStaff)
 *
 * Exception reports live in a separate table (`exception_reports`). The
 * user-visible mutation flow — clicking "withdraw" on an ExceptionCard, or
 * an admin setting `status = 'withdrawn'` — updates only that table. If a
 * regression ever wired the chat tools to read from `exception_reports`
 * (e.g. filtering rota, dropping leave rows, mutating current pattern)
 * without a status filter, this test locks in that the assistant's view of
 * rota/leave is INSENSITIVE to that mutation.
 *
 * We assert this by running the same chat request twice against the SAME
 * underlying fixture, differing ONLY in the state of `exception_reports`:
 *   run A — one active exception report (status = 'submitted')
 *   run B — same report withdrawn (status = 'withdrawn')
 * The captured tool outputs must be byte-for-byte identical.
 *
 * If a future turn adds an exception-report tool to chat, this test
 * should be updated (or replaced) to assert the withdrawn rows are
 * kept distinct — see -chat.wellbeing-rejected-vs-cancelled.e2e.test.ts
 * for the pattern.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// --------------------- fixtures ---------------------

const TODAY = "2026-07-06"; // Monday
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const THEATRE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SPECIALTY_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const SESSION_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const rotaAssignments = [
  { staff_id: USER_ID, duty_type: null, session_date: "2026-06-01", session: "am",
    theatre_session_id: SESSION_ID, role_on_list: null, notes: null, supervisor_id: null },
  { staff_id: USER_ID, duty_type: null, session_date: "2026-06-08", session: "am",
    theatre_session_id: SESSION_ID, role_on_list: null, notes: null, supervisor_id: null },
  { staff_id: USER_ID, duty_type: null, session_date: "2026-07-13", session: "am",
    theatre_session_id: SESSION_ID, role_on_list: null, notes: null, supervisor_id: null },
];
const theatreSessions = [
  { id: SESSION_ID, theatre_id: THEATRE_ID, specialty_id: SPECIALTY_ID, is_non_sag: false,
    surgical_consultant: "Mx Surgeon" },
];
const theatres = [{ id: THEATRE_ID, name: "Theatre 1", kind: "main" }];
const specialties = [{ id: SPECIALTY_ID, name: "Orthopaedics" }];

const leaveRows = [
  { type: "annual", start_date: "2026-07-20", end_date: "2026-07-24",
    status: "approved", half_day_start: null, half_day_end: null,
    reason: null, decision_notes: null },
];

// The mutation-under-test: the exception report row is either active or
// withdrawn. Chat MUST NOT read this table for wellbeing/rota answers, so
// this variable being flipped between runs must have zero effect on the
// captured tool payloads.
let exceptionReportsFixture: Array<{ id: string; staff_id: string; status: string }> = [];

// --------------------- Supabase mock ---------------------

interface QueryState {
  table: string;
  eqCols: Record<string, unknown[]>;
  gteCols: Record<string, string>;
  lteCols: Record<string, string>;
  single: boolean;
}

function makeAdminClient() {
  const build = (table: string) => {
    const state: QueryState = {
      table, eqCols: {}, gteCols: {}, lteCols: {}, single: false,
    };
    const resolve = () => Promise.resolve({ data: dataFor(state), error: null });
    const b: any = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      (state.eqCols[col] ??= []).push(val);
      return b;
    };
    b.in = () => b;
    b.gte = (col: string, val: string) => { state.gteCols[col] = val; return b; };
    b.lte = (col: string, val: string) => { state.lteCols[col] = val; return b; };
    b.range = () => b;
    b.limit = () => b;
    b.order = () => b;
    b.or = () => b;
    b.maybeSingle = () => { state.single = true; return b; };
    b.single = b.maybeSingle;
    b.insert = () => ({
      select: () => ({
        maybeSingle: () => Promise.resolve({ data: { id: "new" }, error: null }),
      }),
      then: (r: any) => Promise.resolve({ data: null, error: null }).then(r),
    });
    b.update = () => b;
    b.delete = () => b;
    b.then = (ok: any, err: any) => resolve().then(ok, err);
    return b;
  };
  return {
    from: (t: string) => build(t),
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  };
}

function dataFor(state: QueryState): unknown {
  switch (state.table) {
    case "ai_conversations":
      return state.single ? { id: CONVERSATION_ID, user_id: USER_ID, title: "Chat" } : [];
    case "ai_messages": return [];
    case "user_roles": return state.single ? null : [];
    case "profiles":
      return state.single
        ? { id: USER_ID, full_name: "Dr Test", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Test", grade: "consultant" }];
    case "theatres": return theatres;
    case "specialties": return specialties;
    case "rota_assignments": return rotaAssignments;
    case "theatre_sessions": return theatreSessions;
    case "leave_requests": {
      const approvedOnly = (state.eqCols.status ?? []).includes("approved");
      if (approvedOnly) return leaveRows.filter((r) => r.status === "approved");
      return leaveRows;
    }
    case "leave_allowances":
      return state.single
        ? { annual_days: 32, study_days: 10, leave_year_start: "2026-04-01" }
        : [];
    case "custom_rota_rules": return [];
    case "exception_reports": return exceptionReportsFixture;
    default: return state.single ? null : [];
  }
}

// --------------------- vi.mock hoisted ---------------------

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeAdminClient() }));
vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({} as unknown),
}));
vi.mock("@/lib/gmail.server", () => ({ sendGmail: vi.fn(async () => ({ ok: true })) }));

const captured: {
  leaveSummary: unknown;
  currentPattern: unknown;
  upcomingRota: unknown;
} = { leaveSummary: null, currentPattern: null, upcomingRota: null };

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (opts: { tools: Record<string, any>; system?: string }) => {
      const summaryTool = opts.tools?.get_my_leave_summary;
      const patternTool = opts.tools?.get_staff_current_pattern;
      const rotaTool = opts.tools?.get_my_upcoming_rota;
      const promise = (async () => {
        captured.leaveSummary = summaryTool ? await summaryTool.execute({}) : null;
        captured.currentPattern = patternTool ? await patternTool.execute({}) : null;
        captured.upcomingRota = rotaTool ? await rotaTool.execute({}) : null;
      })();
      return {
        toUIMessageStreamResponse: async () => {
          await promise;
          return new Response(JSON.stringify({ ok: true }), {
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

async function invokeChat(userText: string): Promise<void> {
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
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: userText }] }],
    }),
  });
  const res = await handler({ request: req });
  expect(res.status).toBe(200);
}

async function runAndCapture(): Promise<{
  leaveSummary: unknown;
  currentPattern: unknown;
  upcomingRota: unknown;
}> {
  captured.leaveSummary = null;
  captured.currentPattern = null;
  captured.upcomingRota = null;
  await invokeChat(
    "How does my recent exception report affect my wellbeing and rota?",
  );
  return {
    leaveSummary: captured.leaveSummary,
    currentPattern: captured.currentPattern,
    upcomingRota: captured.upcomingRota,
  };
}

describe(
  "/api/chat e2e — withdrawing an exception does not perturb wellbeing/rota tool payloads",
  () => {
    it(
      "leave-summary + current-pattern + upcoming-rota payloads are byte-identical " +
        "whether the exception is active (submitted) or withdrawn",
      async () => {
        // Run A — an active exception report exists.
        exceptionReportsFixture = [
          { id: "ex-1", staff_id: USER_ID, status: "submitted" },
        ];
        const active = await runAndCapture();

        // Sanity: every wellbeing/rota tool actually produced output.
        expect(active.leaveSummary).not.toBeNull();
        expect(active.currentPattern).not.toBeNull();
        expect(active.upcomingRota).not.toBeNull();

        // Run B — same report, withdrawn.
        exceptionReportsFixture = [
          { id: "ex-1", staff_id: USER_ID, status: "withdrawn" },
        ];
        const withdrawn = await runAndCapture();

        // The three tool payloads the assistant uses to answer wellbeing /
        // rota-impact questions must be identical. Any drift would mean a
        // wellbeing/rota code path is silently reading exception_reports —
        // which it must NOT do without a status filter (and today, must
        // not do at all).
        expect(withdrawn.leaveSummary).toEqual(active.leaveSummary);
        expect(withdrawn.currentPattern).toEqual(active.currentPattern);
        expect(withdrawn.upcomingRota).toEqual(active.upcomingRota);
      },
    );

    it(
      "removing the exception entirely also leaves the payloads unchanged " +
        "(a hard-delete withdraw path is equivalent to a status flip for chat)",
      async () => {
        exceptionReportsFixture = [
          { id: "ex-2", staff_id: USER_ID, status: "submitted" },
        ];
        const active = await runAndCapture();

        exceptionReportsFixture = [];
        const gone = await runAndCapture();

        expect(gone.leaveSummary).toEqual(active.leaveSummary);
        expect(gone.currentPattern).toEqual(active.currentPattern);
        expect(gone.upcomingRota).toEqual(active.upcomingRota);
      },
    );
  },
);
