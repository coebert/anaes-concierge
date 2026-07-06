/**
 * Tests for the chat tool's `get_staff_current_pattern` response shape,
 * exercised through the pure `buildCurrentPatternResponse` reducer that
 * both the chat route and <CurrentPatternCard /> depend on.
 *
 * Verifies that the model-facing summary carries the same:
 *   - dominant-location-per-half-session grid (AM/PM × Mon–Fri)
 *   - weekday scope (Mon–Fri only, weekends excluded)
 *   - `minCount` / `regularityThreshold` gating for one-off shifts
 *   - assumptions/dataSource strings that quote those thresholds
 * that the on-screen "How this was computed" panel exposes to the user.
 */
import { describe, it, expect } from "vitest";
import {
  buildCurrentPatternResponse,
  deriveMinRecurrence,
} from "./staff-current-pattern";
import {
  LOCATION_LABELS,
  suggestedRegularityThreshold,
  type AssignmentLite,
  type SessionLite,
  type SpecialtyLite,
  type TheatreLite,
} from "./staff-working-patterns";

const STAFF = { id: "s1", full_name: "Dr Test", grade: null };

const theatresById = new Map<string, TheatreLite>([
  ["t-main", { id: "t-main", name: "Main 1", kind: "main" }],
  ["t-day", { id: "t-day", name: "DSU 1", kind: "day_surgery" }],
]);
const sessionsById = new Map<string, SessionLite>([
  ["s-main", { id: "s-main", theatre_id: "t-main", specialty_id: null, is_non_sag: false }],
  ["s-day", { id: "s-day", theatre_id: "t-day", specialty_id: null, is_non_sag: false }],
]);
const specialtiesById = new Map<string, SpecialtyLite>();

function theatre(date: string, half: "am" | "pm", sess: "s-main" | "s-day"): AssignmentLite {
  return {
    staff_id: STAFF.id,
    duty_type: "theatre",
    session_date: date,
    session: half,
    theatre_session_id: sess,
  };
}

function build(assignments: AssignmentLite[], windowDays = 90) {
  return buildCurrentPatternResponse({
    profile: STAFF,
    windowDays,
    from: "2025-01-01",
    to: "2025-03-31",
    assignments,
    sessionsById,
    theatresById,
    specialtiesById,
  });
}

describe("chat get_staff_current_pattern — response shape parity with the card", () => {
  it("returns the dominant location per half-session (AM/PM × Mon–Fri) in the weeklyGrid", () => {
    // 3 Mondays AM in main theatres, 1 Monday AM in day surgery.
    const res = build([
      theatre("2025-01-06", "am", "s-main"),
      theatre("2025-01-13", "am", "s-main"),
      theatre("2025-01-20", "am", "s-main"),
      theatre("2025-01-27", "am", "s-day"),
    ]);
    const am = res.weeklyGrid.find((g) => g.session === "am")!;
    // Days array is Mon..Fri, so index 0 = Monday.
    expect(am.days[0].weekday).toBe("Mon");
    expect(am.days[0].location).toBe(LOCATION_LABELS.main);
    expect(am.days[0].recurrence).toBe("3/4");
  });

  it("only reports Mon–Fri; weekend assignments are ignored and never appear in the grid", () => {
    // Saturdays and Sundays only.
    const res = build([
      theatre("2025-01-04", "am", "s-main"), // Sat
      theatre("2025-01-05", "am", "s-main"), // Sun
      theatre("2025-01-11", "am", "s-main"), // Sat
      theatre("2025-01-12", "pm", "s-main"), // Sun
      theatre("2025-01-18", "pm", "s-main"), // Sat
    ]);
    for (const half of res.weeklyGrid) {
      expect(half.days).toHaveLength(5);
      const weekdays = half.days.map((d) => d.weekday);
      expect(weekdays).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
      expect(weekdays).not.toContain("Sat");
      expect(weekdays).not.toContain("Sun");
      // No weekday cell should have populated from weekend data.
      for (const cell of half.days) {
        expect(cell.location).toBeNull();
        expect(cell.recurrence).toBeNull();
      }
    }
  });

  it("gates one-off shifts using the same minCount the card derives from windowDays", () => {
    // Just one Tuesday AM — should never dominate under the shared minCount.
    const res = build([theatre("2025-01-07", "am", "s-main")], 90);
    const threshold = suggestedRegularityThreshold(90);
    const minCount = deriveMinRecurrence(threshold);
    expect(res.regularityThreshold).toBe(threshold);
    expect(res.minRecurrence).toBe(minCount);
    expect(minCount).toBeGreaterThanOrEqual(2);
    const am = res.weeklyGrid.find((g) => g.session === "am")!;
    // Tuesday is index 1 in the Mon–Fri slice.
    expect(am.days[1].location).toBeNull();
    expect(am.days[1].recurrence).toBeNull();
  });

  it("shows a cell as soon as the winning bucket reaches minCount distinct dates", () => {
    // With windowDays=14 the shared minCount is 2, so two Mondays in main are enough.
    const res = build(
      [
        theatre("2025-01-06", "am", "s-main"),
        theatre("2025-01-13", "am", "s-main"),
      ],
      14,
    );
    expect(res.minRecurrence).toBe(2);
    const am = res.weeklyGrid.find((g) => g.session === "am")!;
    expect(am.days[0].location).toBe(LOCATION_LABELS.main);
    expect(am.days[0].recurrence).toBe("2/2");
  });

  it("suppresses a cell whose winning bucket sits below the shared minCount for the window", () => {
    // windowDays=180 -> threshold=6 -> minCount=4. Only 3 Mondays: below the gate.
    const res = build(
      [
        theatre("2025-01-06", "am", "s-main"),
        theatre("2025-01-13", "am", "s-main"),
        theatre("2025-01-20", "am", "s-main"),
      ],
      180,
    );
    expect(res.regularityThreshold).toBe(suggestedRegularityThreshold(180));
    expect(res.minRecurrence).toBe(deriveMinRecurrence(res.regularityThreshold));
    expect(res.minRecurrence).toBeGreaterThan(3);
    const am = res.weeklyGrid.find((g) => g.session === "am")!;
    expect(am.days[0].location).toBeNull();
  });

  it("quotes the same minCount / windowDays / threshold in the assumptions text sent to the model", () => {
    const res = build([theatre("2025-01-06", "am", "s-main")], 90);
    expect(res.assumptions.regularity).toContain(`at least ${res.minRecurrence} distinct dates`);
    expect(res.assumptions.regularity).toContain(`last ${res.windowDays} days`);
    expect(res.assumptions.regularity).toContain(
      `suggested regularity threshold of ${res.regularityThreshold}`,
    );
    expect(res.assumptions.dataSource).toBe(
      `Derived from ${res.assignmentCount} rota assignments in the last ${res.windowDays} days.`,
    );
    // Mirrors the card's Mon–Fri wording.
    expect(res.assumptions.method).toContain("AM/PM × Mon–Fri");
  });
});
