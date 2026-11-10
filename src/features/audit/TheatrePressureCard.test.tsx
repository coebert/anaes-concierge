// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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
      { id: "a", session_date: "2030-01-07", session: "am", theatre_id: "t1", surgical_consultant: "Hidden DIEP text", notes: null },
      { id: "b", session_date: "2030-01-07", session: "am", theatre_id: "t2", surgical_consultant: "robotic", notes: null },
    ],
    [
      { id: "t1", name: "Theatre A", active: true },
      { id: "t2", name: "Theatre B", active: true },
    ],
    [],
  ),
  staffing: null,
});

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
    expect(within(a).getByText("AM")).toBeTruthy();
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
