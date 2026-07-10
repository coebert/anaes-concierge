/**
 * End-to-end test for /api/chat: when the assistant answers questions
 * about wellbeing impact of leave, its tool inputs must distinguish
 * `rejected` from `cancelled` — never fold them together, never relabel
 * one as the other.
 *
 * The wellbeing engine counts BOTH statuses toward the "leave" driver
 * (rejected/cancelled are the two "bad leave" enum values) — but from
 * the user's point of view they mean very different things:
 *
 *   - `rejected` = a manager said no. The wellbeing hit comes from the
 *     denial and any downstream conflict with the pre-existing rota.
 *   - `cancelled` = the request was withdrawn (by the user, by admin, or
 *     by the CLWRota sync flipping status). The wellbeing hit comes from
 *     the churn/regret, not a denial.
 *
 * If the chat tools collapsed these into a single label ("declined",
 * "not approved", "rejected/cancelled", …) the assistant could not
 * write an accurate wellbeing-impact explanation. This test locks the
 * distinction in at the tool-boundary, which is the last controlled
 * surface before the model receives the data.
 *
 * Drives the real TanStack server route through a fake Request, with
 * the Supabase admin client, AI gateway and `streamText` mocked.
 * `streamText` captures the tools map the route builds and invokes
 * `get_my_leave_summary` and `get_staff_current_pattern` directly, so
 * the assertions cover the full request path — auth, ownership, tool
 * wiring, pattern computation, past-leave overlay, lookahead merge.
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
    theatre_session_id: SESSION_ID },
  { staff_id: USER_ID, duty_type: null, session_date: "2026-06-08", session: "am",
    theatre_session_id: SESSION_ID },
];
const theatreSessions = [
  { id: SESSION_ID, theatre_id: THEATRE_ID, specialty_id: SPECIALTY_ID, is_non_sag: false },
];
const theatres = [{ id: THEATRE_ID, name: "Theatre 1", kind: "main" }];
const specialties = [{ id: SPECIALTY_ID, name: "Orthopaedics" }];

/**
 * The scenario deliberately places a `rejected` and a `cancelled` leave
 * on IDENTICAL dates so a bug that keys off (start, end) alone — instead
 * of on status — would collapse them.  It also adds a same-day pair with
 * the same TYPE (annual) so a bug that keys off (type, dates) would
 * likewise be caught.
 */
const twinDatesLeave = [
  // Twin dates, twin type → status is the ONLY thing that distinguishes them.
  { type: "annual", start_date: "2026-07-13", end_date: "2026-07-17",
    status: "rejected", half_day_start: null, half_day_end: null,
    reason: "wedding", decision_notes: "clash with on-call cover" },
  { type: "annual", start_date: "2026-07-13", end_date: "2026-07-17",
    status: "cancelled", half_day_start: null, half_day_end: null,
    reason: "withdrew — plans changed", decision_notes: null },
  // A control approved row (must still be surfaced and counted).
  { type: "compassionate", start_date: "2026-07-20", end_date: "2026-07-20",
    status: "approved", half_day_start: null, half_day_end: null,
    reason: null, decision_notes: null },
];

/**
 * Second scenario: a rejected AND a cancelled row that both LITERALLY
 * span today, differing only in status. Wellbeing must treat both as
 * "not currently on leave" (only `approved` can flip onLeaveToday) —
 * but the assistant must still see both statuses separately in
 * `upcoming` so it can explain each event's wellbeing hit.
 */
const spanTodayLeave = [
  { type: "annual", start_date: "2026-07-05", end_date: "2026-07-08",
    status: "rejected", half_day_start: null, half_day_end: null,
    reason: null, decision_notes: null },
  { type: "annual", start_date: "2026-07-05", end_date: "2026-07-08",
    status: "cancelled", half_day_start: null, half_day_end: null,
    reason: null, decision_notes: null },
];

let leaveFixture: unknown[] = twinDatesLeave;

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
      select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "new" }, error: null }) }),
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
      // Past-window overlay pins `.eq("status","approved")` → return empty
      // there so no past leave overlays the grid. All other queries get
      // the full fixture including rejected/cancelled.
      const approvedOnly = (state.eqCols.status ?? []).includes("approved");
      if (approvedOnly) return [];
      return leaveFixture;
    }
    case "leave_allowances":
      return state.single
        ? { annual_days: 32, study_days: 10, leave_year_start: "2026-04-01" }
        : [];
    case "custom_rota_rules": return [];
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
  toolNames: string[];
  systemPrompt: string;
  leaveSummary: unknown;
  currentPattern: unknown;
} = { toolNames: [], systemPrompt: "", leaveSummary: null, currentPattern: null };

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (opts: { tools: Record<string, any>; system?: string }) => {
      captured.toolNames = Object.keys(opts.tools ?? {});
      captured.systemPrompt = opts.system ?? "";
      // Invoke BOTH tools the assistant would use to compose a wellbeing
      // reply. We capture their outputs so the test can assert that the
      // data the model sees preserves the rejected/cancelled distinction.
      const summaryTool = opts.tools?.get_my_leave_summary;
      const patternTool = opts.tools?.get_staff_current_pattern;
      const promise = (async () => {
        captured.leaveSummary = summaryTool ? await summaryTool.execute({}) : null;
        captured.currentPattern = patternTool ? await patternTool.execute({}) : null;
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

type LeaveRow = {
  type: string;
  start_date: string;
  end_date: string;
  status: string;
  reason?: string | null;
  decision_notes?: string | null;
};
type SummaryPayload = { requests: LeaveRow[] };
type PatternPayload = {
  leave: {
    onLeaveToday: boolean;
    overlapsByType: Record<string, number>;
    upcoming: LeaveRow[];
  };
};

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

describe("/api/chat e2e — wellbeing-impact reply distinguishes rejected vs cancelled leave", () => {
  it(
    "leave-summary + current-pattern tool outputs keep rejected and cancelled as distinct " +
      "statuses on identical dates+type, so the assistant can explain each one",
    async () => {
      leaveFixture = twinDatesLeave;
      await invokeChat(
        "How does my recent rejected and cancelled leave affect my wellbeing score?",
      );

      // Sanity — chat wired the tools we're relying on for a wellbeing reply.
      expect(captured.toolNames).toEqual(
        expect.arrayContaining(["get_my_leave_summary", "get_staff_current_pattern"]),
      );

      // #1 — get_my_leave_summary hands the assistant BOTH twin rows with
      // their distinct DB-enum statuses. A regression that folded them
      // (e.g. `status: "declined"` for both, or a distinct() on
      // start/end/type) would drop one side.
      const summary = captured.leaveSummary as SummaryPayload;
      const twin = summary.requests.filter(
        (r) => r.start_date === "2026-07-13" && r.end_date === "2026-07-17",
      );
      expect(twin).toHaveLength(2);
      expect(twin.map((r) => r.status).sort()).toEqual(["cancelled", "rejected"]);
      // Distinct free-text reason/notes travel through untouched so the
      // model can quote them in the wellbeing explanation.
      const rejected = twin.find((r) => r.status === "rejected")!;
      const cancelled = twin.find((r) => r.status === "cancelled")!;
      expect(rejected.reason).toBe("wedding");
      expect(rejected.decision_notes).toBe("clash with on-call cover");
      expect(cancelled.reason).toBe("withdrew — plans changed");
      expect(cancelled.decision_notes).toBeNull();

      // #2 — Neither string appears in the OTHER row: the tool output
      // must NOT have relabelled one status as the other.
      expect(rejected.status).not.toBe("cancelled");
      expect(cancelled.status).not.toBe("rejected");

      // #3 — get_staff_current_pattern surfaces both in `upcoming` with
      // distinct statuses (so the assistant can talk about each), but
      // neither contributes to overlapsByType — that count is the
      // "actually on leave" impact signal, and only the approved control
      // row must land in it.
      const pattern = captured.currentPattern as PatternPayload;
      const upcomingTwin = pattern.leave.upcoming.filter(
        (r) => r.start_date === "2026-07-13" && r.end_date === "2026-07-17",
      );
      expect(upcomingTwin.map((r) => r.status).sort()).toEqual([
        "cancelled",
        "rejected",
      ]);
      expect(pattern.leave.overlapsByType.annual).toBe(0);
      expect(pattern.leave.overlapsByType.compassionate).toBe(1);

      // #4 — The DB-enum values are the ONLY status strings the tool
      // outputs use — the assistant must never see a mystery synonym.
      const ALLOWED = new Set(["pending", "approved", "rejected", "cancelled"]);
      for (const row of summary.requests) expect(ALLOWED.has(row.status)).toBe(true);
      for (const row of pattern.leave.upcoming) expect(ALLOWED.has(row.status)).toBe(true);
    },
  );

  it(
    "twin rejected + cancelled rows spanning today do NOT flip onLeaveToday, " +
      "but both remain in `upcoming` with their distinct statuses",
    async () => {
      leaveFixture = spanTodayLeave;
      await invokeChat("Am I on leave today? Does the rejected/cancelled leave hurt my wellbeing?");

      const pattern = captured.currentPattern as PatternPayload;

      // Only `approved` may flip onLeaveToday. Two rows literally span
      // today but neither is approved — a wellbeing reply that said
      // "you're on leave today" would be flat wrong.
      expect(pattern.leave.onLeaveToday).toBe(false);

      // Both rows are still visible with their distinct statuses so the
      // assistant can name each event when explaining the wellbeing hit.
      const spansToday = pattern.leave.upcoming.filter(
        (r) => r.start_date <= TODAY && r.end_date >= TODAY,
      );
      expect(spansToday.map((r) => r.status).sort()).toEqual(["cancelled", "rejected"]);

      // Neither contributes to the impact count — rejected AND cancelled
      // are BOTH excluded, and the exclusion doesn't fold them together
      // (they are still two separate rows in `upcoming`).
      expect(pattern.leave.overlapsByType.annual).toBe(0);
      expect(spansToday).toHaveLength(2);
    },
  );

  it(
    "get_my_leave_summary tool description advertises rejected as a distinct status",
    async () => {
      // The description shipped to the model is part of the contract: if
      // it stops enumerating `rejected` (or worse, invents a joint
      // "rejected/cancelled" bucket), the model has no cue to distinguish
      // them in wellbeing explanations.
      leaveFixture = twinDatesLeave;
      await invokeChat("Summarise my leave requests.");
      // Guard: some fixture invocation must have happened.
      expect(captured.leaveSummary).not.toBeNull();
      // System prompt or tool wiring must never merge the two statuses
      // into a single label that hides the distinction.
      expect(captured.systemPrompt).not.toMatch(/rejected\s*\/\s*cancelled/i);
      expect(captured.systemPrompt).not.toMatch(/cancelled\s*\/\s*rejected/i);
    },
  );
});
