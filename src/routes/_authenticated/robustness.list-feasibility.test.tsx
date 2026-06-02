// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import type {
  ListFeasibilityResult,
  FeasibilityThresholds,
} from "@/lib/audit/list-feasibility";

// --- Mocks ---------------------------------------------------------------

// Replace TanStack Router primitives with inert stand-ins so the page can be
// rendered outside a router context.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({
    options: opts,
  }),
  Link: ({
    children,
    to,
    ...rest
  }: React.PropsWithChildren<{ to?: string } & Record<string, unknown>>) =>
    React.createElement("a", { href: to, ...rest }, children),
}));

// Spy on computeListFeasibility while keeping its real types/constants.
const computeListFeasibility = vi.fn();
vi.mock("@/lib/audit/list-feasibility", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/audit/list-feasibility")
  >("@/lib/audit/list-feasibility");
  return { ...actual, computeListFeasibility };
});

// Validation card kicks off its own Supabase queries on mount; stub it.
vi.mock("@/lib/audit/list-feasibility-validation", () => ({
  validateConsultantPatterns: vi.fn(),
}));

// Supabase client never gets called because we stub the two consumers above,
// but provide a safe default in case anything else imports it.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ select: () => ({ data: [], error: null }) }) },
}));

import { Route } from "./robustness.list-feasibility";

// --- Fixture --------------------------------------------------------------

const DEFAULT_THRESHOLDS_FIXTURE: FeasibilityThresholds = {
  ownerMinPct: 80,
  ownerOrDeputyMinPct: 95,
  regularWorkingMinPct: 60,
  minRecurrences: 6,
  forbidShortfall: false,
  wtePerWeeklySession: 0.1,
};

const fixture: ListFeasibilityResult = {
  summary: {
    windowStart: "2026-01-01",
    windowEnd: "2026-06-30",
    thresholds: DEFAULT_THRESHOLDS_FIXTURE,
    totalSlots: 2,
    feasible: 1,
    borderline: 0,
    notFeasible: 1,
    estimatedExtraWte: 0.5,
    activeSasCount: 1,
    sasListSessionsPerWeek: 2,
    sasWteOffset: 0.2,
    estimatedExtraWteWithSas: 0.3,
    theatreAssignmentsTotal: 100,
    theatreAssignmentsLinked: 100,
  },
  consultantPatterns: [
    {
      id: "consultant-aaa",
      name: "Dr Alpha Fixture",
      tenureStart: "2026-01-05",
      tenureEnd: "2026-06-26",
      tenureWeekdays: 125,
      regularSessionsPerWeek: 3,
      cells: [1, 2, 3, 4, 5].flatMap((dow) =>
        (["am", "pm"] as const).map((session) => ({
          dow,
          session,
          totalOccurrences: 20,
          oncallOccurrences: 0,
          workingOccurrences: dow === 5 ? 0 : 12,
          workingPct: dow === 5 ? 0 : 60,
          regular: dow !== 5,
          regularDayOff: dow === 5,
        })),
      ),
    },
  ],
  slots: [
    {
      key: "slot-1",
      dow: 1,
      session: "am",
      theatreId: "t1",
      theatreName: "Theatre Fixture One",
      surgeon: "Mx Surgeon Fixture",
      occurrences: 20,
      ownerId: "consultant-aaa",
      ownerName: "Dr Alpha Fixture",
      ownerCovered: 18,
      ownerPresentPct: 90,
      deputyId: null,
      deputyName: null,
      deputyCovered: 0,
      ownerOrDeputyPct: 90,
      ownerUnavailable: 1,
      ownerFreeButReplaced: 1,
      shortfallsIfLocked: 0,
      verdict: "feasible",
      headcountGap: 0,
      reasons: [],
      candidateOwners: [],
    },
    {
      key: "slot-2",
      dow: 2,
      session: "pm",
      theatreId: "t2",
      theatreName: "Theatre Fixture Two",
      surgeon: "Mx Other Fixture",
      occurrences: 18,
      ownerId: null,
      ownerName: null,
      ownerCovered: 0,
      ownerPresentPct: 0,
      deputyId: null,
      deputyName: null,
      deputyCovered: 0,
      ownerOrDeputyPct: 0,
      ownerUnavailable: 0,
      ownerFreeButReplaced: 0,
      shortfallsIfLocked: 0,
      verdict: "not_feasible",
      headcountGap: 2,
      reasons: ["No consultant regularly works this slot."],
      candidateOwners: [],
    },
  ],
};

// --- Test -----------------------------------------------------------------

describe("regular-list feasibility page", () => {
  it("calls computeListFeasibility and renders consultantPatterns + slots", async () => {
    computeListFeasibility.mockResolvedValue(fixture);

    // Route.options.component is the page; Route is the route definition.
    const Page = (Route as unknown as { options: { component: React.FC } })
      .options.component;

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Page),
      ),
    );

    // Wait for the query to resolve and the slots table to render.
    await waitFor(() => {
      expect(computeListFeasibility).toHaveBeenCalledTimes(1);
    });

    const callArg = computeListFeasibility.mock.calls[0]![0] as {
      monthsBack: number;
      thresholds: FeasibilityThresholds;
    };
    expect(callArg.monthsBack).toBe(6);
    expect(callArg.thresholds).toBeDefined();

    // consultantPatterns rendered
    await waitFor(() => {
      expect(screen.getByText("Dr Alpha Fixture")).toBeTruthy();
    });

    // slots rendered (two distinct slot rows)
    expect(screen.getByText("Theatre Fixture One")).toBeTruthy();
    expect(screen.getByText("Theatre Fixture Two")).toBeTruthy();

    // department summary numbers rendered
    expect(screen.getByText(/2 recurring list slot/)).toBeTruthy();

    cleanup();
  });
});
