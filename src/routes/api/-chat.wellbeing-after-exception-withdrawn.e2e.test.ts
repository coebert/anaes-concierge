/**
 * End-to-end test for /api/chat: withdrawing an exception report (or
 * flipping its status to `withdrawn`) must cause the rota-impact tools —
 * `get_my_upcoming_rota` and `get_staff_current_pattern` — to recalculate
 * on the next call. Active (non-withdrawn) reports annotate the matching
 * assignment; withdrawn reports are excluded and the annotation drops.
 *
 * The chat wellbeing/rota surface:
 *   - get_my_upcoming_rota      (rota_assignments + active exception_reports)
 *   - get_my_leave_summary      (leave_requests + leave_allowances)
 *   - get_staff_current_pattern (rota + leave + active exception_reports)
 *
 * `get_my_leave_summary` remains insensitive to exception status (it
 * only reads leave_requests / leave_allowances).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// --------------------- fixtures ---------------------

const TODAY = "2026-07-06"; // Monday
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const THEATRE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SPECIALTY_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const SESSION_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// Exception raised for the 2026-07-13 AM assignment.
const EXC_EVENT_DATE = "2026-07-13";
const EXC_EVENT_SESSION = "am";

const rotaAssignments = [
  { staff_id: USER_ID, duty_type: null, session_date: "2026-06-01", session: "am",
    theatre_session_id: SESSION_ID, role_on_list: null, notes: null, supervisor_id: null },
  { staff_id: USER_ID, duty_type: null, session_date: "2026-06-08", session: "am",
    theatre_session_id: SESSION_ID, role_on_list: null, notes: null, supervisor_id: null },
  { staff_id: USER_ID, duty_type: null, session_date: EXC_EVENT_DATE, session: EXC_EVENT_SESSION,
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

type ExcRow = {
  id: string;
  trainee_id: string;
  status: string;
  event_date: string;
  event_session: string | null;
  category: string;
  immediate_safety_concern: boolean;
  due_by: string;
};

let exceptionReportsFixture: ExcRow[] = [];

// --------------------- Supabase mock ---------------------

interface QueryState {
  table: string;
  eqCols: Record<string, unknown[]>;
  neqCols: Record<string, unknown[]>;
  gteCols: Record<string, string>;
  lteCols: Record<string, string>;
  single: boolean;
}

function makeAdminClient() {
  const build = (table: string) => {
    const state: QueryState = {
      table, eqCols: {}, neqCols: {}, gteCols: {}, lteCols: {}, single: false,
    };
    const resolve = () => Promise.resolve({ data: dataFor(state), error: null });
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
    case "exception_reports": {
      // Honour the .neq("status", "withdrawn") filter the tools apply.
      const excludeStatuses = new Set(
        (state.neqCols.status ?? []) as string[],
      );
      return exceptionReportsFixture.filter(
        (r) => !excludeStatuses.has(r.status),
      );
    }
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
        // Ask for a longer window so the 2026-07-13 fixture is in range.
        captured.upcomingRota = rotaTool ? await rotaTool.execute({ days: 30 }) : null;
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

function annotatedAssignment(rota: any) {
  return rota.assignments.find((a: any) => a.date === EXC_EVENT_DATE);
}

describe(
  "/api/chat e2e — withdrawing an exception recalculates upcoming-rota and current-pattern",
  () => {
    it(
      "active exception annotates the matching upcoming-rota assignment and " +
        "appears on current-pattern; flipping status to withdrawn drops both",
      async () => {
        // Run A — active exception.
        exceptionReportsFixture = [
          {
            id: "ex-1",
            trainee_id: USER_ID,
            status: "submitted",
            event_date: EXC_EVENT_DATE,
            event_session: EXC_EVENT_SESSION,
            category: "rest",
            immediate_safety_concern: false,
            due_by: "2026-07-20",
          },
        ];
        const active = await runAndCapture();

        const activeAssignment = annotatedAssignment(active.upcomingRota);
        expect(activeAssignment).toBeDefined();
        expect(activeAssignment.exceptions).toHaveLength(1);
        expect(activeAssignment.exceptions[0]).toMatchObject({
          id: "ex-1",
          status: "submitted",
          category: "rest",
        });
        expect((active.currentPattern as any).exceptions).toHaveLength(1);
        expect((active.currentPattern as any).exceptions[0].id).toBe("ex-1");

        // Run B — same report, withdrawn.
        exceptionReportsFixture = [
          {
            id: "ex-1",
            trainee_id: USER_ID,
            status: "withdrawn",
            event_date: EXC_EVENT_DATE,
            event_session: EXC_EVENT_SESSION,
            category: "rest",
            immediate_safety_concern: false,
            due_by: "2026-07-20",
          },
        ];
        const withdrawn = await runAndCapture();

        const withdrawnAssignment = annotatedAssignment(withdrawn.upcomingRota);
        expect(withdrawnAssignment).toBeDefined();
        expect(withdrawnAssignment.exceptions).toEqual([]);
        expect((withdrawn.currentPattern as any).exceptions).toEqual([]);

        // Leave summary does not read exceptions and must be unchanged.
        expect(withdrawn.leaveSummary).toEqual(active.leaveSummary);
      },
    );

    it(
      "hard-deleting the exception is equivalent to a status flip: the " +
        "annotations disappear from both rota tools",
      async () => {
        exceptionReportsFixture = [
          {
            id: "ex-2",
            trainee_id: USER_ID,
            status: "submitted",
            event_date: EXC_EVENT_DATE,
            event_session: EXC_EVENT_SESSION,
            category: "workload",
            immediate_safety_concern: true,
            due_by: "2026-07-20",
          },
        ];
        const active = await runAndCapture();
        expect(annotatedAssignment(active.upcomingRota).exceptions).toHaveLength(1);
        expect((active.currentPattern as any).exceptions).toHaveLength(1);

        exceptionReportsFixture = [];
        const gone = await runAndCapture();
        expect(annotatedAssignment(gone.upcomingRota).exceptions).toEqual([]);
        expect((gone.currentPattern as any).exceptions).toEqual([]);
        expect(gone.leaveSummary).toEqual(active.leaveSummary);
      },
    );
  },
);
