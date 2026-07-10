// @vitest-environment jsdom
/**
 * End-to-end regression for the dev-mode Wellbeing Invalidations panel.
 *
 * Drives the same two user-facing flows the other diagnostics tests
 * cover — cancel a leave request and withdraw an exception via
 * `<ExceptionCard>` — but instead of scraping `console.debug`, it
 * asserts the visible `<WellbeingInvalidationsPanel>` updates in
 * response, entry-by-entry:
 *
 *   1. Two new `[data-testid="wellbeing-diagnostics-entry"]` rows
 *      appear per mutation (one per invalidated query key —
 *      `admin-wellbeing` and `my-wellbeing`).
 *   2. Each row's key text matches the expected query key.
 *   3. Each row's rendered "reason:" text matches the mutation reason.
 *   4. Each row's `<time dateTime>` is a real ISO instant issued
 *      AFTER the click and BEFORE the assertion (bounds the
 *      timestamp, so a regression that hard-codes/caches `at` gets
 *      caught).
 *   5. Panel entry-count badge / header count both agree with the
 *      ring buffer size.
 *
 * The panel itself is gated on `import.meta.env.DEV`, so this test
 * pins DEV=true and restores it afterwards. It is the visual/UX
 * complement to `wellbeing-diagnostics-e2e.integration.test.tsx`
 * (which asserts the console.debug wire) and
 * `wellbeing-diagnostics-prod-noop.e2e.test.tsx` (which asserts prod
 * silence).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invalidateWellbeing, clearWellbeingInvalidations } from "@/features/wellbeing/invalidate";
import { WellbeingInvalidationsPanel } from "@/components/dev/WellbeingInvalidationsPanel";
import { ExceptionCard } from "@/components/exceptions/ExceptionCard";
import type { ExceptionReport } from "@/features/exceptions/types";

// --------------------- shared mock state ---------------------

const USER_ID = "user-panel-diag-1111";
const REPORT_ID = "report-panel-diag-2222";
const LEAVE_REQUEST_ID = "leave-panel-diag-3333";

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

// --------------------- fixtures ---------------------

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

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        {children}
        <WellbeingInvalidationsPanel />
      </QueryClientProvider>
    );
  };
}

/** Open the panel by clicking the collapsed pill. */
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  const pill = await screen.findByRole("button", { name: /WB diag/ });
  await user.click(pill);
}

function readEntries(): Array<{ key: string; reason: string; at: string }> {
  const rows = screen.queryAllByTestId("wellbeing-diagnostics-entry");
  return rows.map((row) => {
    const key = within(row).getByText(/^(admin-wellbeing|my-wellbeing)$/).textContent!;
    // The reason line is `<div>reason: <span>{reason}</span></div>` —
    // grab the inner span directly to avoid picking up the key span.
    const reasonLine = Array.from(row.querySelectorAll("div")).find((d) =>
      /^reason:/.test(d.textContent ?? ""),
    )!;
    const reason = reasonLine.querySelector("span")!.textContent!;
    const at = row.querySelector("time")!.getAttribute("datetime")!;
    return { key, reason, at };
  });
}

// --------------------- lifecycle ---------------------

type MutableEnv = Record<string, unknown>;
const originalDev = (import.meta.env as MutableEnv).DEV;

beforeEach(() => {
  (import.meta.env as MutableEnv).DEV = true;
  clearWellbeingInvalidations();
  // Ensure the panel starts opened so we don't chase the toggle in every test.
  window.localStorage.setItem("wb-diag-open", "1");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem("wb-diag-open");
  (import.meta.env as MutableEnv).DEV = originalDev;
  clearWellbeingInvalidations();
});

// --------------------- tests ---------------------

describe("Wellbeing diagnostics panel updates on cancel-leave / withdraw-exception", () => {
  it(
    "cancelling a leave request adds two entries (admin-wellbeing + my-wellbeing) to the panel " +
      "with reason=leave.cancel and a fresh timestamp",
    async () => {
      const qc = makeQueryClient();
      render(<div />, { wrapper: wrap(qc) });

      // Panel starts empty.
      expect(screen.getByText(/No invalidations yet\./)).toBeTruthy();
      expect(screen.queryAllByTestId("wellbeing-diagnostics-entry")).toHaveLength(0);

      const before = new Date().toISOString();

      // Same inline replica used by the other e2e tests.
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

      // Panel reflects the invalidation on the next render tick.
      await waitFor(() => {
        expect(screen.getAllByTestId("wellbeing-diagnostics-entry")).toHaveLength(2);
      });

      const after = new Date().toISOString();
      const entries = readEntries();

      // Both invalidated query keys are represented, newest-first.
      const keys = entries.map((e) => e.key).sort();
      expect(keys).toEqual(["admin-wellbeing", "my-wellbeing"]);

      for (const entry of entries) {
        expect(entry.reason).toBe("leave.cancel");
        // Bound the timestamp: must be a real ISO string issued during
        // the test window. Catches hard-coded / cached `at` regressions.
        expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(entry.at >= before).toBe(true);
        expect(entry.at <= after).toBe(true);
      }

      // Header count matches ring-buffer size.
      expect(
        screen.getByText(/Wellbeing invalidations/).textContent,
      ).toContain("(2)");
    },
  );

  it(
    "withdrawing an exception via <ExceptionCard> appends two more entries to the panel " +
      "with reason=exception.withdraw and their own timestamps, ordered newest-first",
    async () => {
      const qc = makeQueryClient();
      const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
      const onChange = vi.fn();

      render(
        <ExceptionCard report={makeReport()} canRespond={false} onChange={onChange} />,
        { wrapper: wrap(qc) },
      );

      // Seed one prior invalidation from a DIFFERENT reason so we can
      // prove the withdraw entries land at the TOP of the list and do
      // not overwrite the seeded one.
      const seededAt = new Date().toISOString();
      invalidateWellbeing(qc, "test.seed", { ids: ["seed-x"] });
      await waitFor(() => {
        expect(screen.getAllByTestId("wellbeing-diagnostics-entry")).toHaveLength(2);
      });

      // Withdraw.
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /Hours of work/i }));
      const beforeWithdraw = new Date().toISOString();
      await user.click(screen.getByRole("button", { name: /Withdraw/i }));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getAllByTestId("wellbeing-diagnostics-entry")).toHaveLength(4);
      });
      const afterWithdraw = new Date().toISOString();

      const entries = readEntries(); // newest-first per ring-buffer contract
      // Top two entries are the withdraw pair; bottom two are the seed pair.
      const [w0, w1, s0, s1] = entries;
      for (const entry of [w0, w1]) {
        expect(entry.reason).toBe("exception.withdraw");
        expect(["admin-wellbeing", "my-wellbeing"]).toContain(entry.key);
        expect(entry.at >= beforeWithdraw).toBe(true);
        expect(entry.at <= afterWithdraw).toBe(true);
      }
      expect([w0.key, w1.key].sort()).toEqual(["admin-wellbeing", "my-wellbeing"]);

      for (const entry of [s0, s1]) {
        expect(entry.reason).toBe("test.seed");
        expect(entry.at >= seededAt).toBe(true);
        expect(entry.at <= beforeWithdraw).toBe(true);
      }

      expect(
        screen.getByText(/Wellbeing invalidations/).textContent,
      ).toContain("(4)");

      confirmSpy.mockRestore();
    },
  );

  it("Clear button empties the panel and shows the empty-state placeholder", async () => {
    const qc = makeQueryClient();
    render(<div />, { wrapper: wrap(qc) });

    invalidateWellbeing(qc, "leave.cancel", { ids: [LEAVE_REQUEST_ID] });
    invalidateWellbeing(qc, "exception.withdraw", { ids: [REPORT_ID] });

    await waitFor(() => {
      expect(screen.getAllByTestId("wellbeing-diagnostics-entry")).toHaveLength(4);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Clear/i }));

    await waitFor(() => {
      expect(screen.queryAllByTestId("wellbeing-diagnostics-entry")).toHaveLength(0);
    });
    expect(screen.getByText(/No invalidations yet\./)).toBeTruthy();
    expect(
      screen.getByText(/Wellbeing invalidations/).textContent,
    ).toContain("(0)");
  });
});
