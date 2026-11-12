// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PracticeSummaryReport } from "./PracticeSummaryReport";
import { buildPracticeSummary, practiceSummaryCsv, type PracticeRow } from "./practice-summary";
import { downloadTextFile } from "./download";
import type { PracticeSummaryResult } from "./practice-summary.functions";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const row = (o: Partial<PracticeRow>): PracticeRow => ({
  id: Math.random().toString(36),
  staff_id: ME,
  session_date: "2030-05-06",
  session: "am",
  duty_type: "theatre",
  extra_type: null,
  pa_credit: null,
  attending_consultant_ids: null,
  theatre_session_id: "L1",
  source: "clwrota",
  locally_modified: false,
  clwrota_external_id: null,
  ...o,
});
const fixture = (rows: PracticeRow[]): PracticeSummaryResult => ({
  summary: buildPracticeSummary({
    userId: ME,
    from: "2030-04-01",
    to: "2031-03-31",
    today: "2030-09-30",
    rows,
    lists: new Map([["L1", { specialty: "Synthetic Gynae", location: "Synthetic Theatre 1" }]]),
    rules: { sessions_per_pa: 1, oncall_pa_credit: 1.5, weekend_pa_credit: 3 },
    weekPublication: new Map(),
    weekImport: new Map(),
  }),
  clinician: { name: "Dr Synthetic Me", grade: "consultant" },
  rules: { sessions_per_pa: 1, oncall_pa_credit: 1.5, weekend_pa_credit: 3 },
  weekStatusInstalled: true,
  importTrackingInstalled: true,
  importTrackingSince: "2030-11-10T00:00:00Z",
  generatedAt: "2030-10-01T09:00:00Z",
});

afterEach(cleanup);

describe("PracticeSummaryReport", () => {
  it("renders the evidence caveat, sections and definitions; hides ICU when absent", () => {
    render(
      <PracticeSummaryReport
        data={fixture([row({}), row({ session: "pm", attending_consultant_ids: [OTHER] })])}
        reflection=""
        setReflection={() => {}}
      />,
    );
    expect(screen.getByText(/not a\s+record that the work was delivered/i)).toBeTruthy();
    for (const t of [
      "Overall scope",
      "Activity by duty and half-day",
      "By specialty or area",
      "On-call",
      "Month by month",
      "Data coverage",
      "Definitions",
    ])
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.queryByText("Intensive care, obstetrics and teaching")).toBeNull();
    expect(screen.getByText(/Supervision isn't reported/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(OTHER);
  });

  it("shows ICU when evidenced and an explicit empty-range message", () => {
    const { unmount } = render(
      <PracticeSummaryReport
        data={fixture([row({ duty_type: "icu_consultant_oncall", theatre_session_id: null })])}
        reflection=""
        setReflection={() => {}}
      />,
    );
    expect(screen.getByText("Intensive care, obstetrics and teaching")).toBeTruthy();
    unmount();
    render(<PracticeSummaryReport data={fixture([])} reflection="" setReflection={() => {}} />);
    expect(screen.getByText("No rota entries for you in these dates")).toBeTruthy();
  });

  it("prints the reflection text (print-only block) without saving it", () => {
    render(
      <PracticeSummaryReport
        data={fixture([row({})])}
        reflection="Synthetic reflection"
        setReflection={() => {}}
      />,
    );
    const printBlock = screen.getByText("Synthetic reflection", { selector: "div" });
    expect(printBlock.className).toContain("print:block");
  });
});

describe("CSV download", () => {
  it("downloads the aggregate CSV as a named file", () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const csv = practiceSummaryCsv(fixture([row({})]).summary, {
      generatedAt: "2030-10-01T09:00:00Z",
    });
    downloadTextFile(
      csv,
      "practice-summary_2030-04-01_to_2031-03-31.csv",
      "text/csv;charset=utf-8",
    );
    expect(create).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(click).toHaveBeenCalled();
    expect(csv).toContain('"area","Synthetic Gynae","sessions","1"');
  });
});
