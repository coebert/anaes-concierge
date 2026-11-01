// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

afterEach(() => cleanup());

type Mode = "ok" | "fail" | "hang";
const { modes, inserts } = vi.hoisted(() => ({
  modes: {} as Record<string, Mode>,
  inserts: [] as unknown[],
}));

const SYNTH_TS = { id: "ts-synthetic", specialty_id: null, surgical_consultant: null, notes: null };

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "in", "gte", "lte"]) b[m] = () => b;
      const result = () => {
        const mode = modes[table] ?? "ok";
        if (mode === "hang") return new Promise(() => undefined);
        if (mode === "fail")
          return Promise.resolve({ data: null, error: new Error(`${table} unavailable`) });
        return Promise.resolve({ data: table === "theatre_sessions" ? SYNTH_TS : [], error: null });
      };
      b.maybeSingle = result;
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        result().then(res, rej);
      b.insert = (row: unknown) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      };
      return b;
    },
  },
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/features/rules/custom-rules.functions", () => ({
  checkCustomRuleViolations: vi.fn(async () => ({ violations: [] })),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

import { CellDialog } from "./CellDialog";

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CellDialog
        theatreId="th-synthetic"
        theatreName="Theatre 1"
        date="2026-11-02"
        session="am"
        onOpenChange={() => undefined}
        staff={[]}
        weekDates={["2026-11-02"]}
        weekAssignments={[]}
        contextAssignments={[]}
        jobPlans={[]}
        leave={[]}
        fixedSessions={[]}
        rules={{
          sessions_per_pa: 1,
          max_sessions_per_week: 10,
          max_consecutive_days: 7,
          honour_fixed_sessions: true,
          allow_back_to_back_oncall: false,
        }}
      />
    </QueryClientProvider>,
  );
}

const assignButton = () => screen.getByRole("button", { name: /assign/i });

const SOURCES = [
  "rota_assignments",
  "competencies",
  "specialty_competency_requirements",
  "staff_competencies",
  "staff_practice_preferences",
  "staff_specialty_preferences",
];

beforeEach(() => {
  for (const k of Object.keys(modes)) delete modes[k];
  inserts.length = 0;
});

describe("rota cell dialog validation gate (synthetic)", () => {
  it("all checks loaded → Assign is enabled", async () => {
    renderDialog();
    await waitFor(() => expect((assignButton() as HTMLButtonElement).disabled).toBe(false));
  });

  for (const table of SOURCES) {
    it(`${table} still loading → Assign disabled with a loading note`, async () => {
      modes[table] = "hang";
      renderDialog();
      await screen.findByText(/loading validation checks/i);
      expect((assignButton() as HTMLButtonElement).disabled).toBe(true);
    });

    it(`${table} failed → Assign disabled, Retry recovers`, async () => {
      modes[table] = "fail";
      renderDialog();
      const alert = await screen.findByText(new RegExp(`${table} unavailable`));
      expect((assignButton() as HTMLButtonElement).disabled).toBe(true);
      expect(inserts).toHaveLength(0);
      modes[table] = "ok";
      const notice = alert.closest("[role=alert]") as HTMLElement;
      fireEvent.click(within(notice).getByRole("button", { name: /retry/i }));
      await waitFor(() => expect((assignButton() as HTMLButtonElement).disabled).toBe(false));
    });
  }

  it("theatre session read failed → list save blocked, no Assign, Retry recovers", async () => {
    modes.theatre_sessions = "fail";
    renderDialog();
    const alert = await screen.findByText(/theatre_sessions unavailable/);
    const save = () =>
      screen.getByRole("button", { name: /(create|update) list/i }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^assign$/i })).toBeNull();
    modes.theatre_sessions = "ok";
    fireEvent.click(
      within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", { name: /retry/i }),
    );
    await waitFor(() => expect(save().disabled).toBe(false));
    await waitFor(() => expect((assignButton() as HTMLButtonElement).disabled).toBe(false));
  });
});
