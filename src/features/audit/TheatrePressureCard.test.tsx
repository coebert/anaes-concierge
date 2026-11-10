// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#d">{children}</a>,
}));

import { TheatrePressureCard } from "./TheatrePressureCard";
import { buildTheatrePressureForecast, extractListEvidence } from "./theatre-pressure";

// Synthetic only.
const forecast = buildTheatrePressureForecast({
  rangeStart: "2030-01-07",
  rangeEnd: "2030-01-07",
  evidence: extractListEvidence(
    [
      {
        id: "a",
        session_date: "2030-01-07",
        session: "am",
        theatre_id: "t1",
        surgical_consultant: "Hidden DIEP text",
        notes: null,
      },
      {
        id: "b",
        session_date: "2030-01-07",
        session: "am",
        theatre_id: "t2",
        surgical_consultant: "robotic",
        notes: null,
      },
    ],
    [
      { id: "t1", name: "Theatre A", active: true },
      { id: "t2", name: "Theatre B", active: true },
    ],
    [],
  ),
  staffing: null,
});

afterEach(cleanup);

describe("TheatrePressureCard", () => {
  it("shows tags, theatre, half, unverified cover and no raw label text", () => {
    render(
      <TheatrePressureCard
        forecast={forecast}
        isLoading={false}
        error={null}
        onRetry={() => {}}
        staffingError={new Error("x")}
        staffingLoading={false}
      />,
    );
    const [a, b] = screen.getAllByTestId("pressure-list");
    expect(within(a).getByText("Theatre A")).toBeTruthy();
    expect(within(a).getByText("DIEP")).toBeTruthy();
    expect(within(a).getAllByText("AM").length).toBeGreaterThan(0);
    expect(within(b).getByText("Theatre B")).toBeTruthy();
    expect(within(b).getByText("Robotic")).toBeTruthy();
    expect(screen.getAllByText("Not verified").length).toBe(2);
    expect(screen.getByText(/2 distinct tagged lists on the same day/)).toBeTruthy();
    expect(screen.getByText(/does not predict overruns/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Hidden");
  });

  it("a failed load shows Retry, not an empty forecast", () => {
    const retry = vi.fn();
    render(
      <TheatrePressureCard
        forecast={null}
        isLoading={false}
        error={new Error("boom")}
        onRetry={retry}
        staffingError={null}
        staffingLoading={false}
      />,
    );
    expect(screen.queryByText(/No list in this window/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("TheatrePressureCard — Unverified slots", () => {
  const f = buildTheatrePressureForecast({
    rangeStart: "2030-01-07",
    rangeEnd: "2030-01-08",
    evidence: extractListEvidence(
      [
        {
          id: "x",
          session_date: "2030-01-07",
          session: "am",
          theatre_id: "t1",
          surgical_consultant: null,
          notes: null,
        },
        {
          id: "y",
          session_date: "2030-01-07",
          session: "pm",
          theatre_id: "t2",
          surgical_consultant: null,
          notes: null,
        },
      ],
      [
        { id: "t1", name: "Theatre A", active: true },
        { id: "t2", name: "Theatre B", active: true },
      ],
      [],
      [
        {
          theatre_session_id: "x",
          has_title: false,
          has_note: false,
          has_place_note: false,
          title_tags: [],
          note_tags: [],
          title_group: null,
          scan_truncated: false,
          source_rows_seen: 2,
          evidence_complete: true,
        },
      ],
      "available",
    ),
    staffing: null,
  });

  it("shows each slot with date link, theatre, half and reason; filter narrows; refresh calls back", () => {
    const refresh = vi.fn();
    render(
      <TheatrePressureCard
        forecast={f}
        isLoading={false}
        error={null}
        onRetry={() => {}}
        staffingError={null}
        staffingLoading={false}
        onRefresh={refresh}
      />,
    );
    const section = screen.getByRole("region", { name: "Unverified slots" });
    expect(within(section).getAllByTestId("unverified-slot")).toHaveLength(3);
    expect(within(section).getByText("Blank in rota")).toBeTruthy();
    expect(within(section).getByText("No imported rows")).toBeTruthy();
    expect(within(section).getByText("No lists imported")).toBeTruthy();
    expect(within(section).getByText(/isn't part of the import/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: /Blank in rota \(1\)/ }));
    const rows = within(section).getAllByTestId("unverified-slot");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Theatre A")).toBeTruthy();
    expect(within(rows[0]).getByText("AM")).toBeTruthy();
    expect(within(rows[0]).getByRole("link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
