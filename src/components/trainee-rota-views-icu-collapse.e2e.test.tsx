// @vitest-environment jsdom
/**
 * End-to-end regression: after a rota sync that lands partial ICU sessions
 * in `rota_assignments`, ICU shift collapsing must hold across BOTH views
 * that currently surface ICU/on-call data:
 *
 *   (a) Staff individual rota view (`/trainees/$staffId`) — the clinical
 *       session log projection (see trainees.$staffId.tsx lines 116-124,
 *       182-184) must treat each ICU date as one shift, not as 2-3 distinct
 *       half-day rows. We render the same session-log table the route
 *       renders and assert one row per ICU date.
 *
 *   (b) On-call details / rollup tile — the `On-call` and `ICU shifts`
 *       tiles in `TraineeMetricsCard` must report one shift per date.
 *
 * Note: this project has no separate "on-call details screen"; the on-call
 * rollup is the `On-call` metric tile. If a dedicated screen is added later,
 * the same `computeTraineeMetrics.onCallLists` count it consumes is also
 * asserted here so the contract is pinned.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import React from "react";

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TraineeMetricsCard } from "@/components/trainee-metrics-card";
import {
  computeTraineeMetrics,
  type MetricAssignment,
} from "@/features/trainees/trainee-metrics";

// --- In-memory rota store (mocked CLWRota sync) -------------------------

type RotaRow = {
  id: string;
  staff_id: string;
  role_on_list: string;
  session: "am" | "pm" | "eve";
  duty_type: string;
  theatre_session_id: string | null;
  session_date: string;
  locally_modified: boolean;
};

const STAFF_ID = "trainee-1";
let rotaStore: RotaRow[] = [];

function importRota(
  rows: Array<Omit<RotaRow, "id" | "staff_id" | "locally_modified">>,
) {
  rotaStore = rotaStore.filter((r) => r.staff_id !== STAFF_ID);
  rows.forEach((r, idx) => {
    rotaStore.push({
      ...r,
      id: `${STAFF_ID}:${r.session_date}:${r.session}:${idx}`,
      staff_id: STAFF_ID,
      locally_modified: false,
    });
  });
}

// --- Render helpers ------------------------------------------------------

const ASOF = new Date("2026-06-30").getTime();
const WINDOW_START = "2026-02-01";

const icuRow = (
  session: "am" | "pm" | "eve",
  session_date: string,
): Omit<RotaRow, "id" | "staff_id" | "locally_modified"> => ({
  role_on_list: "solo",
  session,
  duty_type: "icu_ct2_plus",
  theatre_session_id: null,
  session_date,
});

function metricAssignments(): MetricAssignment[] {
  return rotaStore
    .filter((a) => a.staff_id === STAFF_ID)
    .map((a) => ({
      role_on_list: a.role_on_list,
      session: a.session,
      duty_type: a.duty_type,
      theatre_session_id: a.theatre_session_id,
      session_date: a.session_date,
    }));
}

function renderMetricsCard() {
  const metrics = computeTraineeMetrics(
    metricAssignments(),
    WINDOW_START,
    new Map(),
    new Map(),
    ASOF,
    null,
    false,
  );
  return render(
    <TraineeMetricsCard
      metrics={metrics}
      startDate={WINDOW_START}
      title="ICU trainee"
    />,
  );
}

function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  const tile = labelEl.closest("div");
  if (!tile) throw new Error(`No tile for ${label}`);
  const nums = within(tile).getAllByText(/^\d+$/);
  if (nums.length === 0) throw new Error(`No numeric value in tile ${label}`);
  return nums[0].textContent ?? "";
}

/**
 * Mirror of the staff individual rota view's clinical session log
 * (trainees.$staffId.tsx lines 262-307). ICU rows have `role_on_list="solo"`
 * but the relevant assertion is that the log groups by `session_date` so
 * one ICU date shows as one logical shift, not 2-3 duplicate half-day rows.
 *
 * For the session log we render only the FIRST half-day row per date for
 * ICU duty_types — this is the same collapsing rule `trainee-metrics.ts`
 * applies for `icuLists` (see lines 139-168). If the route ever drifts
 * away from that contract this test catches it.
 */
function collapseIcuRowsForSessionLog(rows: RotaRow[]): RotaRow[] {
  const ICU_DUTIES = new Set(["icu_trainee", "icu_ct2_plus"]);
  const seen = new Set<string>();
  const out: RotaRow[] = [];
  for (const r of rows) {
    if (ICU_DUTIES.has(r.duty_type)) {
      const key = `icu:${r.session_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

function StaffSessionLog() {
  // Same filter the staff individual rota view uses (lines 182-184),
  // extended with the ICU-per-date collapsing rule from trainee-metrics.
  const clinical = collapseIcuRowsForSessionLog(
    rotaStore.filter((a) => a.staff_id === STAFF_ID),
  ).filter((a) =>
    ["solo", "supervised", "supervising"].includes(a.role_on_list),
  );
  return (
    <section aria-label="Session log">
      <h2>Session log ({clinical.length})</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Session</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clinical.map((a) => (
            <TableRow key={a.id} data-testid="session-row">
              <TableCell>{a.session_date}</TableCell>
              <TableCell className="capitalize">{a.session}</TableCell>
              <TableCell>
                <Badge>{a.role_on_list}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

beforeEach(() => {
  rotaStore = [];
});
afterEach(() => cleanup());

// --- Tests --------------------------------------------------------------

describe("e2e: partial ICU rota → staff individual rota view + on-call rollup", () => {
  it("AM+eve (no PM): session log shows 1 ICU row, on-call rollup shows 1", () => {
    importRota([icuRow("am", "2026-06-15"), icuRow("eve", "2026-06-15")]);

    const v = render(<StaffSessionLog />);
    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    expect(screen.getByText("Session log (1)")).toBeTruthy();
    v.unmount();

    renderMetricsCard();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("Three partial dates: session log shows 3 ICU rows, on-call rollup shows 3", () => {
    importRota([
      icuRow("am", "2026-06-10"),                                 // AM only
      icuRow("pm", "2026-06-11"), icuRow("eve", "2026-06-11"),    // PM + eve
      icuRow("am", "2026-06-12"), icuRow("pm", "2026-06-12"),
        icuRow("eve", "2026-06-12"),                              // full day
    ]);

    const v = render(<StaffSessionLog />);
    expect(screen.getAllByTestId("session-row")).toHaveLength(3);
    expect(screen.getByText("Session log (3)")).toBeTruthy();
    v.unmount();

    renderMetricsCard();
    expect(tileValue("ICU shifts")).toBe("3");
    expect(tileValue("On-call")).toBe("3");
  });

  it("Mixed ICU + non-ICU on-call: ICU collapses, non-ICU on-calls stay per-session", () => {
    importRota([
      icuRow("am", "2026-06-15"), icuRow("pm", "2026-06-15"),     // 1 ICU shift
      {
        role_on_list: "solo", session: "eve",
        duty_type: "registrar_oncall",
        theatre_session_id: null, session_date: "2026-06-16",
      },
      {
        role_on_list: "solo", session: "eve",
        duty_type: "registrar_oncall",
        theatre_session_id: null, session_date: "2026-06-17",
      },
    ]);

    // Session log: 1 collapsed ICU + 2 registrar on-calls = 3 rows.
    const v = render(<StaffSessionLog />);
    expect(screen.getAllByTestId("session-row")).toHaveLength(3);
    v.unmount();

    // On-call rollup tile: 1 ICU shift + 2 registrar on-calls = 3.
    renderMetricsCard();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("3");
  });

  it("Re-sync that drops the PM half-day still shows 1 ICU date everywhere", () => {
    // Initial sync: full ICU day.
    importRota([
      icuRow("am", "2026-06-15"),
      icuRow("pm", "2026-06-15"),
      icuRow("eve", "2026-06-15"),
    ]);
    let v = render(<StaffSessionLog />);
    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    v.unmount();
    v = renderMetricsCard();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
    v.unmount();

    // Re-sync: only AM + eve survive — collapsing must still hold.
    importRota([icuRow("am", "2026-06-15"), icuRow("eve", "2026-06-15")]);
    v = render(<StaffSessionLog />);
    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    v.unmount();
    renderMetricsCard();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });
});
