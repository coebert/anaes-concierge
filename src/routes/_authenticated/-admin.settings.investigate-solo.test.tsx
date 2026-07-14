// @vitest-environment jsdom
/**
 * End-to-end integration test for the Admin → Settings → Investigate & fix
 * now flow.
 *
 * The real server function `investigateAndFixTraineeSolo` is replaced with
 * a fake that mirrors the production handler:
 *   - holds an in-memory `rota_assignments` store + profile/session lookup,
 *   - runs the SAME `computeSoloCorrections` helper the real handler uses,
 *   - persists category-1 corrections (solo → supervised + supervisor_id)
 *     into the in-memory store when called with `{ apply: true }`.
 *
 * The test drives the React UI (Preview → Investigate & fix now), confirms
 * the confirmation dialog is honoured, and then asserts that the store
 * reflects the corrected labels — i.e. the change was persisted across the
 * server-fn boundary all the way back from the UI click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import {
  computeSoloCorrections,
  type InvestigateAssignment,
  type InvestigateProfile,
  type InvestigateTheatreSession,
} from "@/lib/solo-investigate";

// --- jsdom polyfills (Radix touches these on mount) ---------------------
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- Mocks --------------------------------------------------------------

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({
      options: opts,
    }),
  };
});

vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

// In-memory persistence store + fake `investigateAndFixTraineeSolo` that
// mirrors the real handler's logic.
type StoreAssignment = InvestigateAssignment & {
  supervisor_id: string | null;
};

const store = {
  assignments: [] as StoreAssignment[],
  profiles: new Map<string, InvestigateProfile>(),
  sessions: new Map<string, InvestigateTheatreSession>(),
  reclassificationLog: [] as Array<{
    sync_run_id: string;
    assignment_id: string;
    from_role: string;
    to_role: string;
    reason: string;
  }>,
};

const { investigateMock } = vi.hoisted(() => ({
  investigateMock: vi.fn(),
}));

vi.mock("@/features/clwrota/clwrota.functions", () => ({
  investigateAndFixTraineeSolo: investigateMock,
  // ReclassificationUndoCard also imports these — provide inert stubs so
  // the page renders without trying to hit a real backend.
  listReclassificationRuns: vi.fn().mockResolvedValue([]),
  undoReclassificationRun: vi.fn().mockResolvedValue({ ok: true }),
  // Avoid pulling other unrelated mutations from the settings page.
  testClwRotaConnection: vi.fn(),
  saveClwRotaSettings: vi.fn(),
  syncClwRotaNow: vi.fn(),
  listClwRotaSyncMetrics: vi.fn().mockResolvedValue({ items: [] }),
}));

// Toast stub: capture calls so we can assert on the success message.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

// Import AFTER mocks are registered.
import { InvestigateSoloCard } from "./-admin-settings-investigate-solo-card";

// --- Fake handler -------------------------------------------------------

function runInvestigate(args: { data: { apply: boolean } }) {
  const corrections = computeSoloCorrections({
    assignments: store.assignments,
    profilesById: store.profiles,
    theatreSessionsById: store.sessions,
  });
  const byCategory = {
    consultant_or_sas_on_session: corrections.filter(
      (c) => c.category === "consultant_or_sas_on_session",
    ),
    unmatched_theatre_solo: corrections.filter(
      (c) => c.category === "unmatched_theatre_solo",
    ),
    non_training_label: corrections.filter((c) => c.category === "non_training_label"),
  };

  let applied = 0;
  let sync_run_id: string | null = null;
  if (args.data.apply && byCategory.consultant_or_sas_on_session.length > 0) {
    sync_run_id = "test-run-0001";
    for (const c of byCategory.consultant_or_sas_on_session) {
      const row = store.assignments.find((a) => a.id === c.assignment_id);
      if (!row) continue;
      const fromRole = row.role_on_list;
      row.role_on_list = "supervised";
      if (c.proposed_supervisor_id) row.supervisor_id = c.proposed_supervisor_id;
      store.reclassificationLog.push({
        sync_run_id,
        assignment_id: row.id,
        from_role: fromRole,
        to_role: "supervised",
        reason: c.reason,
      });
      applied++;
    }
  }
  return Promise.resolve({
    ok: true as const,
    window: { start: "2026-04-03", end: "2026-08-02" },
    counts: {
      consultant_or_sas_on_session: byCategory.consultant_or_sas_on_session.length,
      unmatched_theatre_solo: byCategory.unmatched_theatre_solo.length,
      non_training_label: byCategory.non_training_label.length,
    },
    applied,
    sync_run_id,
    sample: corrections.slice(0, 25),
  });
}

// --- Test fixtures + harness -------------------------------------------

function seedStore() {
  store.assignments = [
    // Case 1: trainee solo with a consultant on the same session — must
    // be auto-corrected to supervised with supervisor_id=cons-1.
    {
      id: "asg-cons",
      staff_id: "cons-1",
      role_on_list: "solo",
      theatre_session_id: "ts-1",
      session_date: "2026-06-10",
      duty_type: "theatre",
      session: "am",
      locally_modified: false,
      supervisor_id: null,
    },
    {
      id: "asg-train",
      staff_id: "train-1",
      role_on_list: "solo",
      theatre_session_id: "ts-1",
      session_date: "2026-06-10",
      duty_type: "theatre",
      session: "am",
      locally_modified: false,
      supervisor_id: null,
    },
    // Case 2: trainee solo theatre row without a session id — review only.
    {
      id: "asg-unmatched",
      staff_id: "train-1",
      role_on_list: "solo",
      theatre_session_id: null,
      session_date: "2026-06-11",
      duty_type: "theatre",
      session: "pm",
      locally_modified: false,
      supervisor_id: null,
    },
    // Case 3: trainee solo on a real list with no supervisor — legitimate,
    // must NOT be touched.
    {
      id: "asg-legit",
      staff_id: "train-1",
      role_on_list: "solo",
      theatre_session_id: "ts-real",
      session_date: "2026-06-12",
      duty_type: "theatre",
      session: "am",
      locally_modified: false,
      supervisor_id: null,
    },
  ];
  store.profiles = new Map<string, InvestigateProfile>([
    ["cons-1", { id: "cons-1", grade: "consultant", full_name: "Dr Consultant" }],
    ["train-1", { id: "train-1", grade: "trainee", full_name: "Dr Trainee" }],
  ]);
  store.sessions = new Map<string, InvestigateTheatreSession>([
    ["ts-1", { id: "ts-1", specialty_name: "Orthopaedics" }],
    ["ts-real", { id: "ts-real", specialty_name: "ENT" }],
  ]);
  store.reclassificationLog = [];
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InvestigateSoloCard />
    </QueryClientProvider>,
  );
}

// --- Tests --------------------------------------------------------------

describe("Admin → Settings → Investigate & fix now (e2e)", () => {
  beforeEach(() => {
    seedStore();
    investigateMock.mockReset();
    investigateMock.mockImplementation(runInvestigate);
    toastSuccess.mockReset();
    toastError.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function clickButton(name: RegExp) {
    const btn = screen.getByRole("button", { name });
    return act(async () => {
      fireEvent.click(btn);
    });
  }

  function statValue(labelRegex: RegExp): string {
    const label = screen.getByText(labelRegex);
    const wrapper = label.parentElement as HTMLElement;
    // The Stat wrapper contains [labelDiv, valueDiv].
    const valueDiv = wrapper.children[1] as HTMLElement;
    return valueDiv.textContent ?? "";
  }


  it("preview shows counts without mutating the store", async () => {
    renderCard();

    await clickButton(/preview findings/i);

    await waitFor(() => {
      expect(statValue(/auto-correctable/i)).toBe("1");
    });
    expect(statValue(/review: unmatched theatre row/i)).toBe("1");
    expect(statValue(/review: non-training label/i)).toBe("0");


    // Persistence guarantee: no row was changed by a dry-run preview.
    const train = store.assignments.find((a) => a.id === "asg-train")!;
    expect(train.role_on_list).toBe("solo");
    expect(train.supervisor_id).toBeNull();
    expect(store.reclassificationLog).toHaveLength(0);
    expect(investigateMock).toHaveBeenLastCalledWith({ data: { apply: false } });
  });

  it("Investigate & fix now persists corrected labels and surfaces success", async () => {
    renderCard();

    await clickButton(/investigate & fix now/i);

    await waitFor(() => {
      expect(
        screen.queryByText(/list\(s\) reclassified solo → supervised/i),
      ).not.toBeNull();
    });

    expect(investigateMock).toHaveBeenCalledWith({ data: { apply: true } });

    // --- Persistence assertions ----------------------------------------
    const train = store.assignments.find((a) => a.id === "asg-train")!;
    expect(train.role_on_list).toBe("supervised");
    expect(train.supervisor_id).toBe("cons-1");

    expect(store.assignments.find((a) => a.id === "asg-cons")!.role_on_list).toBe(
      "solo",
    );
    expect(store.assignments.find((a) => a.id === "asg-unmatched")!.role_on_list).toBe(
      "solo",
    );
    expect(store.assignments.find((a) => a.id === "asg-legit")!.role_on_list).toBe(
      "solo",
    );

    expect(store.reclassificationLog).toEqual([
      expect.objectContaining({
        assignment_id: "asg-train",
        from_role: "solo",
        to_role: "supervised",
        sync_run_id: "test-run-0001",
      }),
    ]);

    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/corrected 1 list\(s\)/i),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("re-running investigate after a fix reports zero auto-correctable rows (idempotent)", async () => {
    renderCard();

    await clickButton(/investigate & fix now/i);
    await waitFor(() =>
      expect(
        screen.queryByText(/list\(s\) reclassified solo → supervised/i),
      ).not.toBeNull(),
    );

    await clickButton(/preview findings/i);

    await waitFor(() => {
      expect(statValue(/auto-correctable/i)).toBe("0");
    });


    expect(store.reclassificationLog).toHaveLength(1);
  });

  it("aborting the confirmation prompt does not call the apply endpoint", async () => {
    (window.confirm as unknown as ReturnType<typeof vi.spyOn>).mockReturnValue(false);
    renderCard();

    await clickButton(/investigate & fix now/i);

    expect(investigateMock).not.toHaveBeenCalled();
    const train = store.assignments.find((a) => a.id === "asg-train")!;
    expect(train.role_on_list).toBe("solo");
    expect(store.reclassificationLog).toHaveLength(0);
  });
});
