// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// jsdom polyfills for Radix UI primitives used by the page.
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

// --- Mocks ---------------------------------------------------------------

// Replace TanStack Router primitives with inert stand-ins so the page can be
// rendered outside a router context.
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
    }: React.PropsWithChildren<
      { to?: string } & Record<string, unknown>
    >) => React.createElement("a", { href: to, ...rest }, children),
  };
});

// Spy on computeListFeasibility while keeping its real types/constants.
const { computeListFeasibility } = vi.hoisted(() => ({
  computeListFeasibility: vi.fn(),
}));
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

import { Route, ListFeasibilityPage } from "./robustness.list-feasibility";

// --- Fixture --------------------------------------------------------------

const DEFAULT_THRESHOLDS_FIXTURE: FeasibilityThresholds = {
  ownerPresentMinPct: 80,
  ownerOrDeputyMinPct: 95,
  forbidNewShortfalls: false,
  minOccurrences: 4,
  shortfallDayBusyPct: 70,
  wtePerWeeklySession: 0.1,
  regularWorkingMinPct: 50,
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
  beforeEach(() => {
    computeListFeasibility.mockClear();
  });

  it("calls computeListFeasibility and renders consultantPatterns + slots", async () => {
    computeListFeasibility.mockResolvedValue(fixture);

    // Route.options.component is the lazy-wrapped page; render the source
    // component directly for the SSR-free test environment.
    expect(Route).toBeDefined();
    const Page = ListFeasibilityPage;

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

    // consultantPatterns rendered (the consultant name appears both in the
    // patterns table and in the slot's owner column).
    await waitFor(() => {
      expect(screen.getAllByText("Dr Alpha Fixture").length).toBeGreaterThan(0);
    });

    // slots rendered (two distinct slot rows)
    expect(screen.getAllByText("Theatre Fixture One").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Theatre Fixture Two").length).toBeGreaterThan(0);

    // department summary numbers rendered
    expect(screen.getByText(/2 recurring list slot/)).toBeTruthy();

    cleanup();
  });

  it("renders empty state when consultantPatterns and slots are empty", async () => {
    const emptyFixture: ListFeasibilityResult = {
      ...fixture,
      consultantPatterns: [],
      slots: [],
      summary: {
        ...fixture.summary,
        totalSlots: 0,
        feasible: 0,
        borderline: 0,
        notFeasible: 0,
        estimatedExtraWte: 0,
        estimatedExtraWteWithSas: 0,
      },
    };
    computeListFeasibility.mockResolvedValue(emptyFixture);

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

    await waitFor(() => {
      expect(computeListFeasibility).toHaveBeenCalledTimes(1);
    });

    // Slots table empty state
    expect(
      await screen.findByText("No recurring lists matched the minimum-occurrence filter."),
    ).toBeTruthy();

    // No consultant names rendered
    expect(screen.queryByText("Dr Alpha Fixture")).toBeNull();

    // Summary still renders with 0 slots
    expect(screen.getByText(/0 recurring list slot/)).toBeTruthy();

    cleanup();
  });
});
