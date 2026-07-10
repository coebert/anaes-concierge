/**
 * End-to-end test for /api/chat: withdrawing an exception must change the
 * assistant's RESPONSE TEXT for a wellbeing question, not merely the raw
 * tool payloads. This complements
 * -chat.wellbeing-after-exception-withdrawn.e2e.test.ts, which asserts on
 * tool outputs. Here we synthesise the assistant reply from the tools the
 * chat route hands to `streamText` and assert the reply itself differs.
 *
 * The synthesis is deliberately dumb: the mocked `streamText` picks
 * `get_my_wellbeing_score` from the tools passed in, calls it, and returns
 * a Response whose body embeds the score, band and top-driver label as
 * plain text. The test then hits the real chat POST handler twice against
 * the same fixture set (only exception_reports differ) and asserts the
 * two assistant strings are not equal.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// --------------------- fixtures ---------------------

const TODAY = "2026-07-06";
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Build a batch of exception events spread across the window so removing them
// materially moves the "trainee exception reports" driver and, therefore, the
// composite score. Two events per week for ~8 weeks.
const EXCEPTION_EVENT_DATES = (() => {
  const dates: string[] = [];
  const base = new Date(`${TODAY}T00:00:00Z`);
  for (let w = 1; w <= 8; w++) {
    for (const offset of [0, 3]) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - w * 7 + offset);
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  return dates;
})();

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
  single: boolean;
}

function makeAdminClient() {
  const build = (table: string) => {
    const state: QueryState = {
      table, eqCols: {}, neqCols: {}, single: false,
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
    b.gte = () => b;
    b.lte = () => b;
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
    case "theatres": return [];
    case "specialties": return [];
    case "rota_assignments": return [];
    case "theatre_sessions": return [];
    case "rota_change_log": return [];
    case "leave_requests": return [];
    case "leave_allowances":
      return state.single
        ? { annual_days: 32, study_days: 10, leave_year_start: "2026-04-01" }
        : [];
    case "custom_rota_rules": return [];
    case "pulse_survey_cycles": return [];
    case "pulse_survey_responses": return [];
    case "exception_reports": {
      const exclude = new Set((state.neqCols.status ?? []) as string[]);
      return exceptionReportsFixture.filter((r) => !exclude.has(r.status));
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

// Synthesise the assistant reply from the wellbeing tool's output — this
// is what a real model would do given the tool result. If the tool payload
// changes, the reply changes.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (opts: { tools: Record<string, any> }) => {
      return {
        toUIMessageStreamResponse: async () => {
          const wb = opts.tools?.get_my_wellbeing_score;
          const result = wb ? await wb.execute({}) : null;
          const top = result?.drivers?.[0];
          const reply = result
            ? `Your wellbeing score is ${result.score} (${result.band_label}). ` +
              `Top driver: ${top?.label ?? "none"} (impact ${top?.impact ?? 0}). ` +
              `You have ${result.active_exception_count} active exception reports.`
            : "No wellbeing data available.";
          return new Response(
            JSON.stringify({ assistantText: reply, tool: result }),
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

// --------------------- test ---------------------

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.LOVABLE_API_KEY = "test-key";
});
afterAll(() => vi.useRealTimers());

async function askChat(): Promise<{ assistantText: string; tool: any }> {
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
          parts: [
            {
              type: "text",
              text: "What is my wellbeing score right now and why?",
            },
          ],
        },
      ],
    }),
  });
  const res = await handler({ request: req });
  expect(res.status).toBe(200);
  return (await res.json()) as { assistantText: string; tool: any };
}

function makeExceptions(status: string): ExcRow[] {
  return EXCEPTION_EVENT_DATES.map((d, i) => ({
    id: `ex-${i}`,
    trainee_id: USER_ID,
    status,
    event_date: d,
    event_session: "am",
    category: "rest",
    immediate_safety_concern: false,
    due_by: TODAY,
  }));
}

describe(
  "/api/chat e2e — assistant reply text changes after withdrawing exceptions",
  () => {
    it(
      "same wellbeing question yields a materially different assistant string " +
        "once the exceptions are flipped to `withdrawn`",
      async () => {
        // Run A — many active exception reports across the 90-day window.
        exceptionReportsFixture = makeExceptions("submitted");
        const active = await askChat();

        // Sanity: the tool actually returned a payload that reflects the
        // active reports.
        expect(active.tool).not.toBeNull();
        expect(active.tool.active_exception_count).toBe(
          EXCEPTION_EVENT_DATES.length,
        );
        expect(active.assistantText).toMatch(
          new RegExp(`${EXCEPTION_EVENT_DATES.length} active exception reports`),
        );
        const activeScore: number = active.tool.score;

        // Run B — same reports flipped to withdrawn. The tool must exclude
        // them, which must in turn change the assistant reply.
        exceptionReportsFixture = makeExceptions("withdrawn");
        const withdrawn = await askChat();

        expect(withdrawn.tool.active_exception_count).toBe(0);
        expect(withdrawn.assistantText).toMatch(/0 active exception reports/);

        // The whole assistant reply must not be byte-equal to the pre-withdraw
        // reply. Withdrawing exceptions is expected to raise the score, so
        // also assert the numeric direction — a regression that ignored the
        // status filter would leave the score (and text) unchanged.
        expect(withdrawn.assistantText).not.toBe(active.assistantText);
        expect(withdrawn.tool.score).toBeGreaterThan(activeScore);
      },
    );

    it(
      "withdrawing exceptions ALSO changes the reply when the model asks the " +
        "same follow-up in a fresh turn (no cached response leaks between runs)",
      async () => {
        exceptionReportsFixture = makeExceptions("submitted");
        const first = await askChat();
        const secondSameFixture = await askChat();
        // With the fixture unchanged the reply is deterministic.
        expect(secondSameFixture.assistantText).toBe(first.assistantText);

        exceptionReportsFixture = [];
        const afterAllGone = await askChat();
        expect(afterAllGone.assistantText).not.toBe(first.assistantText);
        expect(afterAllGone.tool.active_exception_count).toBe(0);
      },
    );
  },
);
