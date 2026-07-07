// @vitest-environment jsdom
/**
 * UI tests for the leave request dialog with a half-day range that
 * spans a week boundary (Fri PM → Mon AM).
 *
 * Verifies:
 *   1. Selecting "Afternoon only (skip AM)" for the start day and
 *      "Morning only (skip PM)" for the end day, with valid dates
 *      spanning Fri→Mon, shows a working-days confirmation
 *      ("Approx. 1 working day(s)") and, on submit, inserts the row
 *      with `half_day_start: "pm"` / `half_day_end: "am"`.
 *   2. Selecting the same half-day markers on the SAME date (a
 *      reversed single-day range) surfaces the validation toast
 *      ("no leave time") and does NOT call the insert.
 *   3. Reversed dates (end < start) surface the toast and do not insert.
 *
 * The Radix Select is stubbed with native <select> so userEvent can
 * change values deterministically in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---- Mocks (hoisted) -------------------------------------------------------

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

// Auth: fake user id.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

// notifyLeaveSubmitted is invoked after insert — turn it into a no-op.
vi.mock("@/features/leave/leave-notifications.functions", () => ({
  notifyLeaveSubmitted: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => vi.fn(async () => ({})),
}));

// Capture insert payload; also stub computeLeaveConflicts.
const insertSpy = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (_t: string) => ({
      insert: (row: unknown) => {
        insertSpy(row);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: { id: "L1" }, error: null }),
          }),
        };
      },
    }),
  },
}));
vi.mock("@/features/leave/leave-utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/features/leave/leave-utils")>(
      "@/features/leave/leave-utils",
    );
  return { ...actual, computeLeaveConflicts: vi.fn(async () => []) };
});

// Replace Radix Select with a native <select> so userEvent.selectOptions
// works reliably in jsdom. Children are <SelectItem value>label — flatten
// them into <option>s.
vi.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => {
    const options: React.ReactNode[] = [];
    const collect = (nodes: React.ReactNode) => {
      React.Children.forEach(nodes, (child) => {
        if (!React.isValidElement(child)) return;
        const el = child as React.ReactElement<any>;
        if (el.props && "value" in el.props) {
          options.push(
            <option key={el.props.value} value={el.props.value}>
              {el.props.children}
            </option>,
          );
        } else if (el.props && el.props.children) {
          collect(el.props.children);
        }
      });
    };
    collect(children);
    return (
      <select
        data-testid="mock-select"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options}
      </select>
    );
  };
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Select,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
    SelectContent: passthrough,
    SelectItem: passthrough,
  };
});

// ---- Import after mocks ----------------------------------------------------

import { LeaveRequestDialog } from "@/components/leave-request-dialog";

// ---- Helpers ---------------------------------------------------------------

const FRI = "2026-01-09";
const MON = "2026-01-12";

function getSelects() {
  // Order in the DOM: [type, half-day-start, half-day-end].
  const selects = screen.getAllByTestId("mock-select") as HTMLSelectElement[];
  return { typeSel: selects[0], startSel: selects[1], endSel: selects[2] };
}

async function setDates(startVal: string, endVal: string) {
  const user = userEvent.setup();
  // The `type="date"` inputs are the only two Input elements at the top
  // of the grid — find them by their labels' `for`/id relationship.
  const startInput = screen.getByLabelText("Start date") as HTMLInputElement;
  const endInput = screen.getByLabelText("End date") as HTMLInputElement;
  await user.clear(startInput);
  await user.type(startInput, startVal);
  await user.clear(endInput);
  await user.type(endInput, endVal);
}

// The <Label> in shadcn/ui is not always associated with the sibling
// Input via htmlFor. Fall back to querying inputs directly by type.
function fallbackDateInputs() {
  const inputs = Array.from(
    document.querySelectorAll('input[type="date"]'),
  ) as HTMLInputElement[];
  return { start: inputs[0], end: inputs[1] };
}

async function setDatesResilient(startVal: string, endVal: string) {
  const user = userEvent.setup();
  const { start, end } = fallbackDateInputs();
  // Programmatic assign is more reliable than typing into a date input in jsdom.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  nativeSetter.call(start, startVal);
  start.dispatchEvent(new Event("input", { bubbles: true }));
  start.dispatchEvent(new Event("change", { bubbles: true }));
  nativeSetter.call(end, endVal);
  end.dispatchEvent(new Event("input", { bubbles: true }));
  end.dispatchEvent(new Event("change", { bubbles: true }));
  // Not strictly needed, but keep user in scope so eslint doesn't complain.
  void user;
}

beforeEach(() => {
  toastError.mockClear();
  toastSuccess.mockClear();
  insertSpy.mockClear();
});
afterEach(() => cleanup());

describe("LeaveRequestDialog — week-boundary half-day range", () => {
  it("Fri (PM only) → Mon (AM only) shows the working-days confirmation and inserts with pm/am markers", async () => {
    const user = userEvent.setup();
    render(
      <LeaveRequestDialog open onOpenChange={() => {}} onSubmitted={() => {}} />,
    );

    await setDatesResilient(FRI, MON);

    const { startSel, endSel } = getSelects();
    await user.selectOptions(startSel, "pm");
    await user.selectOptions(endSel, "am");

    // Confirmation of the working-day count is visible.
    expect(
      await screen.findByText(/Approx\./i),
    ).toHaveTextContent(/1\s*working day\(s\)/i);

    await user.click(screen.getByRole("button", { name: /submit request/i }));

    // Insert called exactly once with the correct half-day mapping.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const payload = insertSpy.mock.calls[0][0] as {
      start_date: string;
      end_date: string;
      half_day_start: string | null;
      half_day_end: string | null;
    };
    expect(payload.start_date).toBe(FRI);
    expect(payload.end_date).toBe(MON);
    expect(payload.half_day_start).toBe("pm");
    expect(payload.half_day_end).toBe("am");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("Same-day PM-start + AM-end (reversed single day) surfaces a validation error and does not insert", async () => {
    const user = userEvent.setup();
    render(
      <LeaveRequestDialog open onOpenChange={() => {}} onSubmitted={() => {}} />,
    );

    await setDatesResilient(FRI, FRI);

    const { startSel, endSel } = getSelects();
    await user.selectOptions(startSel, "pm");
    await user.selectOptions(endSel, "am");

    await user.click(screen.getByRole("button", { name: /submit request/i }));

    expect(insertSpy).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    // Message from validateHalfDayRange for `reversed_single_day`.
    expect(String(toastError.mock.calls[0][0])).toMatch(/no leave time/i);
  });

  it("Reversed dates (end < start) surface a validation error and do not insert", async () => {
    const user = userEvent.setup();
    render(
      <LeaveRequestDialog open onOpenChange={() => {}} onSubmitted={() => {}} />,
    );

    await setDatesResilient(MON, FRI);

    await user.click(screen.getByRole("button", { name: /submit request/i }));

    expect(insertSpy).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toMatch(
      /end date must be on or after start date/i,
    );
  });
});
