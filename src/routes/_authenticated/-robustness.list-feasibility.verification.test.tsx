// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

import type {
  ListFeasibilityResult,
  FeasibilityThresholds,
} from "@/lib/audit/list-feasibility";
import type { DiagnosedReport } from "@/lib/audit/list-feasibility-diagnosis";

// --- Mocks ---------------------------------------------------------------

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({
      options: opts,
    }),
    Link: ({
      children,
      to,
      ...rest
    }: React.PropsWithChildren<{ to?: string } & Record<string, unknown>>) =>
      React.createElement("a", { href: to, ...rest }, children),
  };
});

const { computeListFeasibility } = vi.hoisted(() => ({
  computeListFeasibility: vi.fn(),
}));
vi.mock("@/lib/audit/list-feasibility", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/audit/list-feasibility")
  >("@/lib/audit/list-feasibility");
  return { ...actual, computeListFeasibility };
});

const { validateConsultantPatterns } = vi.hoisted(() => ({
  validateConsultantPatterns: vi.fn(),
}));
vi.mock("@/lib/audit/list-feasibility-validation", () => ({
  validateConsultantPatterns,
}));

const { diagnoseValidationReport } = vi.hoisted(() => ({
  diagnoseValidationReport: vi.fn(),
}));
vi.mock("@/lib/audit/list-feasibility-diagnosis", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/audit/list-feasibility-diagnosis")
  >("@/lib/audit/list-feasibility-diagnosis");
  return { ...actual, diagnoseValidationReport };
});

// Supabase mock: track .select() reads on the labels table and .upsert() writes.
const supabaseState = {
  tokens: [] as string[],
  selectCalls: 0,
  upsertCalls: 0,
};

vi.mock("@/integrations/supabase/client", () => {
  const tableApi = (table: string) => ({
    select: (_cols?: string) => ({
      order: (_col: string, _opts?: unknown) => {
        if (table === "validation_custom_non_working_labels") {
          supabaseState.selectCalls += 1;
          return Promise.resolve({
            data: supabaseState.tokens.map((token) => ({ token })),
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      },
    }),
    upsert: (rows: Array<{ token: string }>) => {
      if (table === "validation_custom_non_working_labels") {
        supabaseState.upsertCalls += 1;
        for (const r of rows) {
          if (!supabaseState.tokens.includes(r.token)) {
            supabaseState.tokens.push(r.token);
          }
        }
      }
      return Promise.resolve({ data: null, error: null });
    },
  });
  return { supabase: { from: (table: string) => tableApi(table) } };
});

import { ListFeasibilityPage } from "./-list-feasibility-page";

// --- Fixtures ------------------------------------------------------------

const DEFAULT_THRESHOLDS_FIXTURE: FeasibilityThresholds = {
  ownerPresentMinPct: 80,
  ownerOrDeputyMinPct: 95,
  forbidNewShortfalls: false,
  minOccurrences: 4,
  shortfallDayBusyPct: 70,
  wtePerWeeklySession: 0.1,
  regularWorkingMinPct: 50,
};

function makeModelFixture(
  feasible: number,
  borderline: number,
  notFeasible: number,
): ListFeasibilityResult {
  return {
    summary: {
      windowStart: "2026-01-01",
      windowEnd: "2026-06-30",
      thresholds: DEFAULT_THRESHOLDS_FIXTURE,
      totalSlots: feasible + borderline + notFeasible,
      feasible,
      borderline,
      notFeasible,
      estimatedExtraWte: 0,
      activeSasCount: 0,
      sasListSessionsPerWeek: 0,
      sasWteOffset: 0,
      estimatedExtraWteWithSas: 0,
      theatreAssignmentsTotal: 100,
      theatreAssignmentsLinked: 100,
    },
    consultantPatterns: [],
    slots: [],
  };
}

function makeDiagnosedReport(extraToken: string): DiagnosedReport {
  return {
    generatedAt: new Date().toISOString(),
    windowStart: "2026-01-01",
    windowEnd: "2026-06-30",
    monthsBack: 6,
    sampleCap: 10,
    mismatchThresholdPct: 15,
    totalCells: 1,
    cellsWithMismatch: 1,
    consultantsWithMismatch: 1,
    causeTally: [],
    consultants: [
      {
        id: "consultant-aaa",
        name: "Dr Alpha Verify",
        tenureStart: "2026-01-05",
        tenureEnd: "2026-06-26",
        maxAbsDelta: 40,
        mismatchCount: 1,
        topDiagnosis: null,
        cells: [
          {
            dow: 1,
            session: "am",
            modelPct: 80,
            modelRegular: true,
            modelRegularDayOff: false,
            tenureDates: 25,
            sampleSize: 10,
            clinical: 4,
            offDayLabel: 0,
            otherDuty: 6,
            noRecord: 0,
            sampledPct: 40,
            delta: -40,
            mismatch: true,
            samples: [],
            diagnoses: [
              {
                code: "unrecognised_off_label",
                severity: "warn",
                summary: `Treat "${extraToken}" as a non-working label`,
                evidence: [`Found ${extraToken} on 6/10 sampled rows`],
                remediation: {
                  kind: "extend-non-working-labels",
                  summary: `Add "${extraToken}" to the non-working labels list`,
                  payload: { tokens: [extraToken] },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

// --- Tests ---------------------------------------------------------------

describe("verification step: recomputes counts from updated labels", () => {
  beforeEach(() => {
    computeListFeasibility.mockReset();
    validateConsultantPatterns.mockReset();
    diagnoseValidationReport.mockReset();
    supabaseState.tokens = [];
    supabaseState.selectCalls = 0;
    supabaseState.upsertCalls = 0;
  });

  async function mountPage() {
    computeListFeasibility.mockResolvedValue(makeModelFixture(2, 0, 1));
    validateConsultantPatterns.mockResolvedValue({} as never);
    diagnoseValidationReport.mockReturnValue(makeDiagnosedReport("Study Leave"));

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(ListFeasibilityPage),
      ),
    );

    // Wait for initial page model render.
    await waitFor(() => {
      expect(computeListFeasibility).toHaveBeenCalledTimes(1);
    });

    // Kick off validation.
    const runBtn = await screen.findByRole("button", { name: /Run validation/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(validateConsultantPatterns).toHaveBeenCalled();
      expect(diagnoseValidationReport).toHaveBeenCalled();
    });
  }

  it("re-reads tokens from supabase and recomputes the model with them on Apply all", async () => {
    await mountPage();

    // After diagnose, "Apply all fixes & re-run" button should appear.
    const applyAllBtn = await screen.findByRole("button", {
      name: /Apply all fixes & re-run/i,
    });

    // Switch the recomputed model fixture so the verification banner shows
    // different counts than the initial render.
    computeListFeasibility.mockResolvedValueOnce(makeModelFixture(3, 0, 0));

    fireEvent.click(applyAllBtn);

    // Verification banner appears with the recomputed counts read AFTER the
    // upsert wrote the new token.
    await waitFor(() => {
      expect(screen.getByText(/Verification complete/i)).toBeTruthy();
    });

    // The upsert wrote "Study Leave" into the tokens store.
    expect(supabaseState.upsertCalls).toBeGreaterThanOrEqual(1);
    expect(supabaseState.tokens).toContain("Study Leave");

    // The verification step explicitly re-read tokens from the DB.
    expect(supabaseState.selectCalls).toBeGreaterThanOrEqual(1);

    // The model was recomputed with the freshly fetched tokens.
    const lastCall =
      computeListFeasibility.mock.calls[
        computeListFeasibility.mock.calls.length - 1
      ]![0] as { extraNonWorkingTokens?: string[] };
    expect(lastCall.extraNonWorkingTokens).toEqual(["Study Leave"]);

    // The banner reflects the *recomputed* counts (3 feasible / 0 not feasible),
    // not the initial-render counts (2 feasible / 1 not feasible).
    const banner = screen.getByText(/Recomputed list verdicts/i);
    expect(banner.textContent ?? "").toMatch(/feasible\s*3/);
    expect(banner.textContent ?? "").toMatch(/not feasible\s*0/);

    // And the token in effect is surfaced for human verification.
    expect(banner.textContent ?? "").toMatch(/Study Leave/);

    cleanup();
  });

  it("recomputes with the union of pre-existing and newly applied tokens", async () => {
    // Seed an existing token before mounting so verification can confirm it
    // merges DB state rather than only using the just-applied tokens.
    supabaseState.tokens = ["Annual Leave"];

    await mountPage();

    const applyAllBtn = await screen.findByRole("button", {
      name: /Apply all fixes & re-run/i,
    });

    computeListFeasibility.mockResolvedValueOnce(makeModelFixture(3, 0, 0));

    fireEvent.click(applyAllBtn);

    await waitFor(() => {
      expect(screen.getByText(/Verification complete/i)).toBeTruthy();
    });

    const lastCall =
      computeListFeasibility.mock.calls[
        computeListFeasibility.mock.calls.length - 1
      ]![0] as { extraNonWorkingTokens?: string[] };

    // Verification recomputed using EVERY token now stored in the DB —
    // both the pre-existing one and the just-applied remediation token.
    expect(lastCall.extraNonWorkingTokens).toEqual(
      expect.arrayContaining(["Annual Leave", "Study Leave"]),
    );
    expect(lastCall.extraNonWorkingTokens?.length).toBe(2);

    cleanup();
  });
});
