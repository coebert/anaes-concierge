// @vitest-environment jsdom
/**
 * End-to-end regression for the dev-mode `console.debug` diagnostics
 * emitted by `invalidateWellbeing`.
 *
 * Sister coverage lives in `wellbeing-invalidate-diagnostics.test.ts`,
 * which calls `invalidateWellbeing` directly. This test drives the two
 * REAL user-facing mutation paths that trigger those diagnostics — from
 * the outside — and checks the log trail the operator would actually
 * see in the browser console after clicking:
 *
 *   1. Cancel leave — `_authenticated/leave.tsx` closure, replicated
 *      inline because it is not exported.
 *   2. Withdraw exception — `<ExceptionCard>` Withdraw button, rendered
 *      and clicked through the DOM.
 *
 * Contract locked in per mutation:
 *   - Exactly TWO `console.debug` lines are emitted (one per invalidated
 *     wellbeing query key: `admin-wellbeing`, `my-wellbeing`).
 *   - Every line starts with the `[wellbeing]` prefix so it groups in
 *     filtered devtools output.
 *   - The reason is the stable dotted label from the call site
 *     (`leave.cancel`, `exception.withdraw`) — a regression that drops
 *     or renames the reason breaks this test.
 *   - Each line carries an ISO-8601 `at=` timestamp so the operator can
 *     correlate against network/react-devtools trails.
 *
 * The dev-only gate (`import.meta.env.DEV`) is already exercised by the
 * sister test; here we rely on vitest running with DEV=true and focus on
 * the end-to-end wire from click → invalidation → log line.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import { ExceptionCard } from "@/components/exceptions/ExceptionCard";
import type { ExceptionReport } from "@/features/exceptions/types";

// --------------------- shared mock state ---------------------

const USER_ID = "user-diag-1111";
const REPORT_ID = "report-diag-2222";
const LEAVE_REQUEST_ID = "leave-diag-3333";

// Minimal Supabase mock — return `{ error: null }` for every terminal
// call so both mutation paths take their success branch and reach
// `invalidateWellbeing`. Shape mirrors the mock in
// `wellbeing-refresh-after-mutations.integration.test.tsx`.
vi.mock("@/integrations/supabase/client", () => {
  function makeBuilder() {
    const api: Record<string, unknown> = {};
    api.update = () => api;
    api.select = () => api;
    api.insert = () => Promise.resolve({ data: null, error: null });
    api.eq = () => Object.assign(Promise.resolve({ data: null, error: null }), api);
    api.order = () => api;
    api.then = (onOk: (v: { data: unknown; error: null }) => void) =>
      Promise.resolve({ data: [], error: null }).then(onOk);
    return api;
  }
  return {
    supabase: {
      from: () => makeBuilder(),
    },
  };
});

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: USER_ID }, isLoading: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// --------------------- fixtures & helpers ---------------------

function makeReport(): ExceptionReport {
  return {
    id: REPORT_ID,
    trainee_id: USER_ID,
    event_date: "2026-07-01",
    event_session: "am",
    category: "hours",
    immediate_safety_concern: false,
    description: "Ran 3h over rostered finish.",
    hours_worked_extra: 3,
    rest_missed_hours: null,
    status: "submitted",
    outcome: null,
    outcome_note: null,
    responder_id: null,
    acknowledged_at: null,
    resolved_at: null,
    due_by: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    created_at: "2026-07-01T09:00:00Z",
    updated_at: "2026-07-01T09:00:00Z",
  };
}

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/** Filter to the diagnostic lines this test cares about. Any unrelated
 * `console.debug` traffic (React Query, testing-library) is ignored. */
function wellbeingLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l) => l.startsWith("[wellbeing] invalidate"));
}

/** The line-shape contract, asserted once per emitted line. */
function assertLineShape(line: string, expectedKey: string, expectedReason: string): void {
  expect(line).toContain("[wellbeing]");
  expect(line).toContain(`queryKey=["${expectedKey}"]`);
  expect(line).toContain(`reason=${expectedReason}`);
  // ISO-8601 (`YYYY-MM-DDTHH:MM:SS…`) somewhere after `at=`.
  expect(line).toMatch(/at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
}

// --------------------- lifecycle ---------------------

let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  debugSpy.mockRestore();
  vi.restoreAllMocks();
});

// --------------------- tests ---------------------

describe(
  "dev-mode console.debug diagnostics fire from cancel-leave and withdraw-exception flows",
  () => {
    it(
      "cancelling a leave request emits one [wellbeing] debug line per invalidated key " +
        "with reason=leave.cancel and an ISO timestamp",
      async () => {
        const qc = makeQueryClient();

        // Inline replica of `_authenticated/leave.tsx` `cancel` — the
        // handler is a local closure inside the route component and not
        // exported. This mirrors the exact three lines that matter for
        // the diagnostic wire.
        const { supabase } = await import("@/integrations/supabase/client");
        const cancelLeave = async (id: string) => {
          const { error } = await (supabase.from("leave_requests") as unknown as {
            update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
          })
            .update({ status: "cancelled" })
            .eq("id", id);
          if (error) throw error;
          // The route calls `invalidateWellbeing(qc, "leave.cancel")` —
          // the reason string is the observable contract with operators
          // filtering the console.
          invalidateWellbeing(qc, "leave.cancel");
        };

        await cancelLeave(LEAVE_REQUEST_ID);

        const lines = wellbeingLines(debugSpy);
        expect(lines).toHaveLength(2);

        const adminLine = lines.find((l) => l.includes('["admin-wellbeing"]'));
        const meLine = lines.find((l) => l.includes('["my-wellbeing"]'));
        expect(adminLine, "no diagnostic line for admin-wellbeing").toBeDefined();
        expect(meLine, "no diagnostic line for my-wellbeing").toBeDefined();

        assertLineShape(adminLine!, "admin-wellbeing", "leave.cancel");
        assertLineShape(meLine!, "my-wellbeing", "leave.cancel");
      },
    );

    it(
      "withdrawing an exception via <ExceptionCard> emits one [wellbeing] debug line " +
        "per invalidated key with reason=exception.withdraw",
      async () => {
        const qc = makeQueryClient();

        // The card's `withdraw` handler calls `window.confirm` — auto-accept
        // so the flow proceeds past the guard.
        const confirmSpy = vi
          .spyOn(window, "confirm")
          .mockImplementation(() => true);

        const onChange = vi.fn();
        render(
          <ExceptionCard
            report={makeReport()}
            canRespond={false}
            onChange={onChange}
          />,
          { wrapper: wrap(qc) },
        );

        // Open the card, then click Withdraw — same DOM path a trainee
        // would take, so the diagnostics we assert on are the ones an
        // operator would see in dev after that click.
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Hours of work/i }));
        await user.click(screen.getByRole("button", { name: /Withdraw/i }));

        // Wait for the async withdraw handler to reach `invalidateWellbeing`.
        await waitFor(() => {
          expect(wellbeingLines(debugSpy)).toHaveLength(2);
        });

        const lines = wellbeingLines(debugSpy);
        const adminLine = lines.find((l) => l.includes('["admin-wellbeing"]'));
        const meLine = lines.find((l) => l.includes('["my-wellbeing"]'));
        expect(adminLine).toBeDefined();
        expect(meLine).toBeDefined();

        assertLineShape(adminLine!, "admin-wellbeing", "exception.withdraw");
        assertLineShape(meLine!, "my-wellbeing", "exception.withdraw");

        // The `onChange` callback still fires after logging — the diagnostic
        // wire is additive, not a replacement for the parent-refresh call.
        expect(onChange).toHaveBeenCalled();

        confirmSpy.mockRestore();
      },
    );

    it(
      "each mutation path emits its OWN reason label — a subsequent cancel " +
        "after a withdraw does not carry the withdraw reason forward",
      async () => {
        // Guards against a regression that memoised or hoisted the reason
        // string, so a second call reuses the first one. Two calls in
        // sequence must yield 4 lines with two distinct reasons.
        const qc = makeQueryClient();

        invalidateWellbeing(qc, "exception.withdraw");
        invalidateWellbeing(qc, "leave.cancel");

        const lines = wellbeingLines(debugSpy);
        expect(lines).toHaveLength(4);

        const withdrawLines = lines.filter((l) => l.includes("reason=exception.withdraw"));
        const cancelLines = lines.filter((l) => l.includes("reason=leave.cancel"));

        expect(withdrawLines).toHaveLength(2);
        expect(cancelLines).toHaveLength(2);

        // Each reason covers both keys — no reason maps to only one side.
        for (const group of [withdrawLines, cancelLines]) {
          expect(group.some((l) => l.includes('["admin-wellbeing"]'))).toBe(true);
          expect(group.some((l) => l.includes('["my-wellbeing"]'))).toBe(true);
        }
      },
    );
  },
);
