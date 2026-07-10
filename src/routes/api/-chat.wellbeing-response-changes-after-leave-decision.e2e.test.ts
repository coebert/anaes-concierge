/**
 * End-to-end regression for /api/chat: the assistant's REPLY TEXT for a
 * wellbeing question must change after leave is cancelled or rejected,
 * and the change must be anchored on `decided_at` (the moment the leave
 * flipped to rejected/cancelled) — not `start_date`.
 *
 * This is the leave-side twin of
 * -chat.wellbeing-response-changes-after-withdraw.e2e.test.ts, which asserts
 * the same "reply text actually changes" contract for exception withdrawal.
 *
 * Why decided_at matters:
 *   - `computeWellbeing` counts a leave row as a "bad leave" driver only if
 *     status ∈ {rejected, cancelled} AND its anchor date is inside the
 *     90-day window. The anchor is `decided_at.slice(0,10)` when present,
 *     `start_date` otherwise (`src/features/wellbeing/wellbeing-score.ts`
 *     lines 109–114).
 *   - A regression that anchors on `start_date` even when `decided_at` is
 *     set would either (a) miss cancellations of far-future leave decided
 *     today, or (b) count old cancellations whose decision fell out of the
 *     window months ago. Both distort what the chat tells the trainee.
 *
 * The mocked `streamText` synthesises a reply from `get_my_wellbeing_score`
 * that embeds the score, band, and the "leave" driver's exact label
 * (`"N rejected/cancelled leave"`). Two chat requests are then compared:
 * once with the leave rows as approved/future, once with the same rows
 * flipped to cancelled/rejected with `decided_at = today`. The reply must
 * differ, the leave driver value must move, and the score must drop.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// --------------------- fixtures ---------------------

const TODAY = "2026-07-06";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CONVERSATION_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

/** ISO 3+ days from TODAY in the given direction, so start_date is > windowEnd
 *  when we want to prove the decision date (not the leave date) is what counts. */
function addDaysISO(iso: string, delta: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

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
        maybeSingle: () =>
          Promise.resolve({ data: { id: "new" }, error: null }),
      }),
      then: (r: any) =>
        Promise.resolve({ data: null, error: null }).then(r),
    });
    b.update = () => b;
    b.delete = () => b;
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
    case "ai_messages": return [];
    case "user_roles": return state.single ? null : [];
    case "profiles":
      return state.single
        ? { id: USER_ID, full_name: "Dr Test", grade: "consultant", email: null }
        : [{ id: USER_ID, full_name: "Dr Test", grade: "consultant" }];
    case "leave_requests": return leaveFixture;
    case "leave_allowances":
      return state.single
        ? { annual_days: 32, study_days: 10, leave_year_start: "2026-04-01" }
        : [];
    default: return state.single ? null : [];
  }
}

// --------------------- vi.mock hoisted ---------------------

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeAdminClient() }));
vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({} as unknown),
}));
vi.mock("@/lib/gmail.server", () => ({ sendGmail: vi.fn(async () => ({ ok: true })) }));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
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
              `Leave signal: ${leaveDriver?.label ?? "n/a"} ` +
              `(impact ${leaveDriver?.impact ?? 0}). ` +
              `Window ${tool.windowStart} → ${tool.windowEnd}.`
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

// --------------------- helpers ---------------------

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.LOVABLE_API_KEY = "test-key";
});
afterAll(() => vi.useRealTimers());

async function askChat(): Promise<{
  assistantText: string;
  tool: {
    score: number;
    drivers: Array<{ key: string; value: number; label: string; impact: number }>;
    windowStart: string;
    windowEnd: string;
  };
}> {
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
          parts: [{ type: "text", text: "How is my wellbeing looking right now?" }],
        },
      ],
    }),
  });
  const res = await handler({ request: req });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

/** Three annual-leave rows — three fills the driver's cap so the change is
 *  guaranteed to shift the score. */
function threeLeaveRows(
  status: "approved" | "cancelled" | "rejected",
  opts: { startOffset: number; decidedAt: string | null },
): LeaveRow[] {
  return [0, 1, 2].map((i) => ({
    staff_id: USER_ID,
    type: "annual",
    // For "cancelled/rejected in-window", parking start_date is fine.
    // For the decided_at-anchoring test we push start_date far outside
    // the window so ONLY decided_at can bring the row in.
    start_date: addDaysISO(TODAY, opts.startOffset + i),
    end_date: addDaysISO(TODAY, opts.startOffset + i),
    status,
    decided_at: opts.decidedAt,
    half_day_start: null,
    half_day_end: null,
  }));
}

// --------------------- tests ---------------------

describe(
  "/api/chat e2e — wellbeing reply reflects cancelled/rejected leave via decided_at",
  () => {
    it(
      "chat reply changes when the user's leave flips from approved to cancelled " +
        "(decided_at = today) — the leave driver appears and the score drops",
      async () => {
        // A) Approved leave, no decision yet, dated inside the window.
        //    Leave driver value must be 0 — approved leave is not "bad leave".
        leaveFixture = threeLeaveRows("approved", {
          startOffset: -10, // start_date within the 90-day window
          decidedAt: null,
        });
        const approved = await askChat();
        const approvedLeave = approved.tool.drivers.find((d) => d.key === "leave")!;
        expect(approvedLeave.value).toBe(0);
        expect(approved.assistantText).toMatch(/0 rejected\/cancelled leave/);

        // B) Same three rows, now cancelled with decided_at = TODAY.
        //    computeWellbeing anchors on decided_at, so all 3 fall in-window
        //    and the leave driver saturates at 3 (cap = 3 events).
        leaveFixture = threeLeaveRows("cancelled", {
          startOffset: -10,
          decidedAt: `${TODAY}T09:00:00Z`,
        });
        const cancelled = await askChat();
        const cancelledLeave = cancelled.tool.drivers.find((d) => d.key === "leave")!;
        expect(cancelledLeave.value).toBe(3);
        expect(cancelled.assistantText).toMatch(/3 rejected\/cancelled leave/);

        // C) Reply text and score must materially differ from case A.
        expect(cancelled.assistantText).not.toBe(approved.assistantText);
        expect(cancelled.tool.score).toBeLessThan(approved.tool.score);
      },
    );

    it(
      "chat reply changes when leave is rejected today for a start_date that " +
        "sits BEYOND the 90-day window — proves decided_at anchoring (not start_date)",
      async () => {
        // Baseline: same three future-dated leaves, still approved, decided
        // outside window. start_date is 200 days in the future, well past
        // the 90-day rolling wellbeing window.
        leaveFixture = threeLeaveRows("approved", {
          startOffset: 200,
          decidedAt: addDaysISO(TODAY, -400) + "T09:00:00Z",
        });
        const beforeReject = await askChat();
        const beforeLeave = beforeReject.tool.drivers.find((d) => d.key === "leave")!;
        expect(beforeLeave.value).toBe(0);

        // Flip to rejected TODAY. start_date is still 200 days out; a
        // regression that anchors on start_date would keep the driver at
        // 0 and the reply unchanged. The correct behaviour is: decided_at
        // is inside the window, so all three count.
        leaveFixture = threeLeaveRows("rejected", {
          startOffset: 200,
          decidedAt: `${TODAY}T10:00:00Z`,
        });
        const afterReject = await askChat();
        const afterLeave = afterReject.tool.drivers.find((d) => d.key === "leave")!;
        expect(
          afterLeave.value,
          "rejecting today must count via decided_at even when start_date is out of window",
        ).toBe(3);

        expect(afterReject.assistantText).not.toBe(beforeReject.assistantText);
        expect(afterReject.tool.score).toBeLessThan(beforeReject.tool.score);
      },
    );

    it(
      "a rejection decided long ago (decided_at outside window) does NOT change " +
        "the reply, even though the leave itself is still rejected",
      async () => {
        // Old rejection: decided 200 days ago, start_date also old. Nothing
        // about this row falls inside the 90-day window, so the leave
        // driver must stay at 0 and the reply must be identical to the
        // "no bad leave" baseline. This guards against a regression that
        // ignored the window filter after the status filter.
        leaveFixture = threeLeaveRows("rejected", {
          startOffset: -300,
          decidedAt: addDaysISO(TODAY, -200) + "T09:00:00Z",
        });
        const oldReject = await askChat();
        const oldLeave = oldReject.tool.drivers.find((d) => d.key === "leave")!;
        expect(oldLeave.value).toBe(0);
        expect(oldReject.assistantText).toMatch(/0 rejected\/cancelled leave/);

        // Sanity: rebuild the same "no bad leave" baseline via approved
        // rows and confirm the reply is byte-equal — i.e. the OLD rejection
        // truly contributes nothing.
        leaveFixture = threeLeaveRows("approved", {
          startOffset: -10,
          decidedAt: null,
        });
        const baseline = await askChat();
        expect(oldReject.assistantText).toBe(baseline.assistantText);
      },
    );
  },
);
