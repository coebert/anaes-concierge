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
} from "@/features/audit/list-feasibility";

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
vi.mock("@/features/audit/list-feasibility", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/audit/list-feasibility")
  >("@/features/audit/list-feasibility");
  return { ...actual, computeListFeasibility };
});

// Validation card kicks off its own Supabase queries on mount; stub it.
vi.mock("@/features/audit/list-feasibility-validation", () => ({
  validateConsultantPatterns: vi.fn(),
}));

// Supabase client never gets called because we stub the two consumers above,
// but provide a safe default in case anything else imports it.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ select: () => ({ data: [], error: null }) }) },
}));

import { ListFeasibilityPage } from "./-list-feasibility-page";
import { Route } from "./robustness.list-feasibility";

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

  it("renders consultant patterns but empty slots state when slots are empty", async () => {
    const partialFixture: ListFeasibilityResult = {
      ...fixture,
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
    computeListFeasibility.mockResolvedValue(partialFixture);

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

    // consultantPatterns rendered
    await waitFor(() => {
      expect(screen.getAllByText("Dr Alpha Fixture").length).toBeGreaterThan(0);
    });

    // Slots empty state
    expect(
      await screen.findByText("No recurring lists matched the minimum-occurrence filter."),
    ).toBeTruthy();

    // Summary shows 0 slots
    expect(screen.getByText(/0 recurring list slot/)).toBeTruthy();

    cleanup();
  });

  it("renders slots but no patterns card when consultantPatterns are empty", async () => {
    const partialFixture: ListFeasibilityResult = {
      ...fixture,
      consultantPatterns: [],
      summary: {
        ...fixture.summary,
        totalSlots: 2,
        feasible: 1,
        notFeasible: 1,
      },
    };
    computeListFeasibility.mockResolvedValue(partialFixture);

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

    // Slots rendered
    await waitFor(() => {
      expect(screen.getAllByText("Theatre Fixture One").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Theatre Fixture Two").length).toBeGreaterThan(0);

    // WorkingPatternsCard returns null when patterns are empty
    expect(screen.queryByText("Consultant working patterns")).toBeNull();

    // Summary shows 2 slots
    expect(screen.getByText(/2 recurring list slot/)).toBeTruthy();

    cleanup();
  });

  it("renders both consultantPatterns and slots together with correct counts", async () => {
    // Use a fixture with multiple consultants and varied verdicts so counts
    // are non-trivial and can be checked against the rendered rows.
    const richFixture: ListFeasibilityResult = {
      summary: {
        windowStart: "2026-01-01",
        windowEnd: "2026-06-30",
        thresholds: DEFAULT_THRESHOLDS_FIXTURE,
        totalSlots: 3,
        feasible: 2,
        borderline: 0,
        notFeasible: 1,
        estimatedExtraWte: 0.2,
        activeSasCount: 1,
        sasListSessionsPerWeek: 2,
        sasWteOffset: 0.2,
        estimatedExtraWteWithSas: 0.0,
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
        {
          id: "consultant-bbb",
          name: "Dr Beta Fixture",
          tenureStart: "2026-01-05",
          tenureEnd: "2026-06-26",
          tenureWeekdays: 125,
          regularSessionsPerWeek: 2,
          cells: [1, 2, 3, 4, 5].flatMap((dow) =>
            (["am", "pm"] as const).map((session) => ({
              dow,
              session,
              totalOccurrences: 20,
              oncallOccurrences: 2,
              workingOccurrences: 10,
              workingPct: 50,
              regular: dow <= 3,
              regularDayOff: dow > 3,
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
          ownerId: "consultant-aaa",
          ownerName: "Dr Alpha Fixture",
          ownerCovered: 16,
          ownerPresentPct: 88,
          deputyId: null,
          deputyName: null,
          deputyCovered: 0,
          ownerOrDeputyPct: 88,
          ownerUnavailable: 2,
          ownerFreeButReplaced: 0,
          shortfallsIfLocked: 0,
          verdict: "feasible",
          headcountGap: 0,
          reasons: [],
          candidateOwners: [],
        },
        {
          key: "slot-3",
          dow: 3,
          session: "am",
          theatreId: "t3",
          theatreName: "Theatre Fixture Three",
          surgeon: "Mx Third Fixture",
          occurrences: 15,
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
          headcountGap: 1,
          reasons: ["No consultant regularly works this slot."],
          candidateOwners: [],
        },
      ],
    };

    computeListFeasibility.mockResolvedValue(richFixture);

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

    // Both consultant names appear (in WorkingPatternsCard or slots table)
    await waitFor(() => {
      expect(screen.getAllByText("Dr Alpha Fixture").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Dr Beta Fixture").length).toBeGreaterThan(0);

    // All three theatres appear in the slots table
    expect(screen.getAllByText("Theatre Fixture One").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Theatre Fixture Two").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Theatre Fixture Three").length).toBeGreaterThan(0);

    // Summary counts rendered exactly as returned
    expect(screen.getByText(/3 recurring list slot/)).toBeTruthy();

    // Count rendered table rows — each slot produces exactly one <tr>
    const tableRows = screen.getAllByRole("row");
    // Slots table has a header row plus one row per slot (3)
    // Working-patterns table has two header rows plus two data rows
    // Total rows across all tables: 4 (slots) + 4 (patterns) = 8
    expect(tableRows.length).toBe(8);

    // Verdict badges in the slots table match summary counts
    // "Feasible" / "Not feasible" also appear as summary stat labels, so
    // total occurrences are label + badge(s).
    expect(screen.getAllByText("Feasible").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Not feasible").length).toBeGreaterThanOrEqual(1);

    cleanup();
  });

  it("renders AM and PM session labels correctly in slot rows", async () => {
    const amPmFixture: ListFeasibilityResult = {
      summary: {
        windowStart: "2026-01-01",
        windowEnd: "2026-06-30",
        thresholds: DEFAULT_THRESHOLDS_FIXTURE,
        totalSlots: 4,
        feasible: 2,
        borderline: 1,
        notFeasible: 1,
        estimatedExtraWte: 0.3,
        activeSasCount: 0,
        sasListSessionsPerWeek: 0,
        sasWteOffset: 0,
        estimatedExtraWteWithSas: 0.3,
        theatreAssignmentsTotal: 50,
        theatreAssignmentsLinked: 50,
      },
      consultantPatterns: [
        {
          id: "consultant-ccc",
          name: "Dr Gamma Fixture",
          tenureStart: "2026-01-05",
          tenureEnd: "2026-06-26",
          tenureWeekdays: 125,
          regularSessionsPerWeek: 4,
          cells: [1, 2, 3, 4, 5].flatMap((dow) =>
            (["am", "pm"] as const).map((session) => ({
              dow,
              session,
              totalOccurrences: 20,
              oncallOccurrences: 0,
              workingOccurrences: 15,
              workingPct: 75,
              regular: true,
              regularDayOff: false,
            })),
          ),
        },
      ],
      slots: [
        {
          key: "slot-am-1",
          dow: 1,
          session: "am",
          theatreId: "t1",
          theatreName: "AM Theatre One",
          surgeon: "Mx AM Surgeon",
          occurrences: 20,
          ownerId: "consultant-ccc",
          ownerName: "Dr Gamma Fixture",
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
          key: "slot-am-2",
          dow: 3,
          session: "am",
          theatreId: "t2",
          theatreName: "AM Theatre Two",
          surgeon: "Mx AM Surgeon Two",
          occurrences: 18,
          ownerId: "consultant-ccc",
          ownerName: "Dr Gamma Fixture",
          ownerCovered: 16,
          ownerPresentPct: 88,
          deputyId: null,
          deputyName: null,
          deputyCovered: 0,
          ownerOrDeputyPct: 88,
          ownerUnavailable: 2,
          ownerFreeButReplaced: 0,
          shortfallsIfLocked: 0,
          verdict: "borderline",
          headcountGap: 0,
          reasons: ["Owner present % is near threshold."],
          candidateOwners: [],
        },
        {
          key: "slot-pm-1",
          dow: 1,
          session: "pm",
          theatreId: "t3",
          theatreName: "PM Theatre One",
          surgeon: "Mx PM Surgeon",
          occurrences: 20,
          ownerId: "consultant-ccc",
          ownerName: "Dr Gamma Fixture",
          ownerCovered: 14,
          ownerPresentPct: 70,
          deputyId: null,
          deputyName: null,
          deputyCovered: 0,
          ownerOrDeputyPct: 70,
          ownerUnavailable: 4,
          ownerFreeButReplaced: 2,
          shortfallsIfLocked: 1,
          verdict: "not_feasible",
          headcountGap: 1,
          reasons: ["Owner present % below threshold."],
          candidateOwners: [],
        },
        {
          key: "slot-pm-2",
          dow: 4,
          session: "pm",
          theatreId: "t4",
          theatreName: "PM Theatre Two",
          surgeon: "Mx PM Surgeon Two",
          occurrences: 22,
          ownerId: "consultant-ccc",
          ownerName: "Dr Gamma Fixture",
          ownerCovered: 20,
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
      ],
    };

    computeListFeasibility.mockResolvedValue(amPmFixture);

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

    // Every slot row should show its day label together with AM or PM.
    // The session text is rendered as uppercase inside the first cell of each row.
    const amPmFixtureSlots = amPmFixture.slots;

    // Each slot's theatre name should appear in the document
    for (const slot of amPmFixtureSlots) {
      expect((await screen.findAllByText(slot.theatreName)).length).toBeGreaterThan(0);
    }

    // Verify AM and PM session labels are present in the slots table
    const amLabels = await screen.findAllByText("AM");
    const pmLabels = await screen.findAllByText("PM");
    // AM appears in 2 slots + possibly elsewhere (e.g. assumptions card)
    expect(amLabels.length).toBeGreaterThanOrEqual(2);
    expect(pmLabels.length).toBeGreaterThanOrEqual(2);

    // Count total slot rows in the slots table (header row + data rows)
    // We verify the summary count matches the fixture
    expect(await screen.findByText(/4 recurring list slot/)).toBeTruthy();

    // Verify the summary stat numbers match AM + PM counts
    // The Stat component renders the value inside a div with text-xl font-semibold
    const summaryCard = (await screen.findAllByText(/4 recurring list slot/))[0]!.closest("[class*='rounded-xl']") as HTMLElement;
    expect(summaryCard).toBeTruthy();

    cleanup();
  });

  it("matches summary counts to the number of AM and PM rows shown", async () => {
    // Create a fixture with 3 AM slots and 2 PM slots, each with known verdicts.
    const mixedFixture: ListFeasibilityResult = {
      summary: {
        windowStart: "2026-01-01",
        windowEnd: "2026-06-30",
        thresholds: DEFAULT_THRESHOLDS_FIXTURE,
        totalSlots: 5,
        feasible: 3,
        borderline: 1,
        notFeasible: 1,
        estimatedExtraWte: 0.2,
        activeSasCount: 0,
        sasListSessionsPerWeek: 0,
        sasWteOffset: 0,
        estimatedExtraWteWithSas: 0.2,
        theatreAssignmentsTotal: 60,
        theatreAssignmentsLinked: 60,
      },
      consultantPatterns: [],
      slots: [
        {
          key: "slot-1",
          dow: 1,
          session: "am",
          theatreId: "t1",
          theatreName: "Mon AM Theatre",
          surgeon: "Mx One",
          occurrences: 20,
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
          verdict: "feasible",
          headcountGap: 0,
          reasons: [],
          candidateOwners: [],
        },
        {
          key: "slot-2",
          dow: 2,
          session: "am",
          theatreId: "t2",
          theatreName: "Tue AM Theatre",
          surgeon: "Mx Two",
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
          verdict: "borderline",
          headcountGap: 0,
          reasons: ["Near threshold."],
          candidateOwners: [],
        },
        {
          key: "slot-3",
          dow: 3,
          session: "am",
          theatreId: "t3",
          theatreName: "Wed AM Theatre",
          surgeon: "Mx Three",
          occurrences: 15,
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
          headcountGap: 1,
          reasons: ["No owner."],
          candidateOwners: [],
        },
        {
          key: "slot-4",
          dow: 1,
          session: "pm",
          theatreId: "t4",
          theatreName: "Mon PM Theatre",
          surgeon: "Mx Four",
          occurrences: 20,
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
          verdict: "feasible",
          headcountGap: 0,
          reasons: [],
          candidateOwners: [],
        },
        {
          key: "slot-5",
          dow: 2,
          session: "pm",
          theatreId: "t5",
          theatreName: "Tue PM Theatre",
          surgeon: "Mx Five",
          occurrences: 22,
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
          verdict: "feasible",
          headcountGap: 0,
          reasons: [],
          candidateOwners: [],
        },
      ],
    };

    computeListFeasibility.mockResolvedValue(mixedFixture);

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

    // Summary should show totalSlots = 5 (3 AM + 2 PM)
    expect(await screen.findByText(/5 recurring list slot/)).toBeTruthy();

    // Count rows in the slots table: header + 5 data rows
    const allRows = await screen.findAllByRole("row");
    // WorkingPatternsCard is absent because consultantPatterns is empty,
    // so only the slots table contributes rows.
    expect(allRows.length).toBe(6); // 1 header + 5 data

    // Each theatre name should be present exactly once in the slots table
    for (const slot of mixedFixture.slots) {
      expect((await screen.findAllByText(slot.theatreName)).length).toBe(1);
    }

    // Verify verdict counts in summary match fixture
    // feasible = 3, borderline = 1, notFeasible = 1
    // The stat labels "Feasible", "Borderline", "Not feasible" each appear once
    // plus the verdict badges in the table rows.
    const feasibleTexts = await screen.findAllByText("Feasible");
    const borderlineTexts = await screen.findAllByText("Borderline");
    const notFeasibleTexts = await screen.findAllByText("Not feasible");

    // Label (1) + badges in table rows (3) + assumptions card (1) = 5
    expect(feasibleTexts.length).toBe(5);
    // Label (1) + badge in table row (1) + assumptions card (1) = 3
    expect(borderlineTexts.length).toBe(3);
    // Label (1) + badge in table row (1) + assumptions card (1) = 3
    expect(notFeasibleTexts.length).toBe(3);

    cleanup();
  });
});
