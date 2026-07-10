// @vitest-environment jsdom
/**
 * End-to-end regression for the PROD no-op path of the dev-mode
 * `console.debug` diagnostics emitted by `invalidateWellbeing`.
 *
 * The sister test `wellbeing-diagnostics-e2e.integration.test.tsx`
 * proves the diagnostics fire in dev. This test proves the SAME two
 * user-facing flows (cancel leave, withdraw exception) are silent —
 * zero `console.debug` lines with the `[wellbeing]` prefix and zero
 * new entries in the in-memory ring buffer — when the bundle is NOT
 * running under `import.meta.env.DEV`.
 *
 * Why this matters:
 *   - `recordWellbeingInvalidation` is gated behind `if
 *     (!import.meta.env.DEV) return;`. A regression that flips the
 *     guard (e.g. dropping the `!`, using `import.meta.env.PROD`
 *     incorrectly, or moving the gate below the `console.debug`) would
 *     leak internal cache-invalidation trails into every production
 *     browser console — noisy, and potentially informative to
 *     attackers about internal state.
 *   - The prod path must ALSO still perform the actual
 *     `invalidateQueries` work; silencing logging must not silence the
 *     cache refresh.
 *
 * We flip `import.meta.env.DEV` to `false` via `vi.stubEnv` for the
 * duration of each test, and restore it in `afterEach`. Both flows are
 * exercised through the same shape as the dev-mode e2e — the inline
 * cancel-leave closure and the real `<ExceptionCard>` Withdraw click —
 * so the assertions cover the entire wire from click → invalidation.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  invalidateWellbeing,
  getWellbeingInvalidations,
  clearWellbeingInvalidations,
} from "@/features/wellbeing/invalidate";
import { ExceptionCard } from "@/components/exceptions/ExceptionCard";
import type { ExceptionReport } from "@/features/exceptions/types";

// --------------------- shared mock state ---------------------

const USER_ID = "user-prod-diag-1111";
const REPORT_ID = "report-prod-diag-2222";
const LEAVE_REQUEST_ID = "leave-prod-diag-3333";

// Same minimal Supabase mock shape as the dev-mode e2e — every
// terminal call resolves `{ error: null }` so both flows take the
// success branch and reach `invalidateWellbeing`.
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

function wellbeingLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.startsWith("[wellbeing] invalidate"));
}

// --------------------- lifecycle ---------------------

let debugSpy: ReturnType<typeof vi.spyOn>;
// `import.meta.env` values are read at call-time inside
// `recordWellbeingInvalidation`, so mutating the property before each
// test is enough — no module cache reset needed.
type MutableEnv = Record<string, unknown>;
const originalDev = (import.meta.env as MutableEnv).DEV;

beforeEach(() => {
  (import.meta.env as MutableEnv).DEV = false;
  clearWellbeingInvalidations();
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  debugSpy.mockRestore();
  vi.restoreAllMocks();
  (import.meta.env as MutableEnv).DEV = originalDev;
  clearWellbeingInvalidations();
});

// --------------------- tests ---------------------

describe(
  "prod-mode invalidateWellbeing is silent — no console.debug diagnostics from cancel-leave / withdraw-exception",
  () => {
    it(
      "cancel-leave path emits ZERO [wellbeing] console.debug lines and ZERO ring-buffer entries " +
        "when import.meta.env.DEV is false",
      async () => {
        const qc = makeQueryClient();
        const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

        // Inline replica of the leave.tsx cancel closure — same shape
        // as the dev-mode e2e, so the two tests differ ONLY in the
        // DEV flag.
        const { supabase } = await import("@/integrations/supabase/client");
        const cancelLeave = async (id: string) => {
          const { error } = await (supabase.from("leave_requests") as unknown as {
            update: (p: unknown) => { eq: (c: string, v: string) => Promise<{ error: null }> };
          })
            .update({ status: "cancelled" })
            .eq("id", id);
          if (error) throw error;
          invalidateWellbeing(qc, "leave.cancel", { ids: [id] });
        };

        await cancelLeave(LEAVE_REQUEST_ID);

        // The observable prod contract: no diagnostic lines whatsoever.
        expect(wellbeingLines(debugSpy)).toEqual([]);
        // Ring buffer must also stay empty — the dev-diagnostics panel
        // is not populated in prod.
        expect(getWellbeingInvalidations()).toEqual([]);

        // Yet the actual cache work MUST still happen — silencing logs
        // must not silence invalidation.
        expect(invalidateSpy).toHaveBeenCalledTimes(2);
        const keys = invalidateSpy.mock.calls.map(
          (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
        );
        expect(keys).toContainEqual(["admin-wellbeing"]);
        expect(keys).toContainEqual(["my-wellbeing"]);
      },
    );

    it(
      "withdraw-exception via <ExceptionCard> emits ZERO [wellbeing] console.debug lines " +
        "and ZERO ring-buffer entries when import.meta.env.DEV is false",
      async () => {
        const qc = makeQueryClient();
        const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

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

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Hours of work/i }));
        await user.click(screen.getByRole("button", { name: /Withdraw/i }));

        // Wait until the withdraw handler has finished — proxy via
        // onChange, which fires after `invalidateWellbeing`.
        await waitFor(() => {
          expect(onChange).toHaveBeenCalled();
        });

        expect(wellbeingLines(debugSpy)).toEqual([]);
        expect(getWellbeingInvalidations()).toEqual([]);

        // Cache invalidation still runs — just silently.
        const keys = invalidateSpy.mock.calls.map(
          (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
        );
        expect(keys).toContainEqual(["admin-wellbeing"]);
        expect(keys).toContainEqual(["my-wellbeing"]);

        confirmSpy.mockRestore();
      },
    );

    it(
      "flipping DEV back on mid-suite restores the diagnostics — proves the guard is " +
        "read at call-time, not baked in at module load",
      () => {
        const qc = makeQueryClient();

        // Prod mode (set in beforeEach) — silent.
        invalidateWellbeing(qc, "leave.cancel");
        expect(wellbeingLines(debugSpy)).toEqual([]);
        expect(getWellbeingInvalidations()).toEqual([]);

        // Flip DEV on and call again — now noisy.
        (import.meta.env as MutableEnv).DEV = true;
        invalidateWellbeing(qc, "exception.withdraw");
        const lines = wellbeingLines(debugSpy);
        expect(lines).toHaveLength(2);
        expect(lines.every((l) => l.includes("reason=exception.withdraw"))).toBe(
          true,
        );
        expect(getWellbeingInvalidations()).toHaveLength(2);
      },
    );
  },
);
