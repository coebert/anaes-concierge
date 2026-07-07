import { describe, it, expect } from "vitest";
import { buildInbox } from "./inbox";

const today = new Date("2026-07-07T09:00:00Z");

const names = new Map<string, string>([
  ["s1", "Ada Smith"],
  ["s2", "Ben Jones"],
]);

describe("buildInbox", () => {
  it("sorts safety-flagged exceptions ahead of everything else", () => {
    const items = buildInbox({
      leave: [
        { id: "L1", staff_id: "s1", type: "annual", status: "pending",
          start_date: "2026-08-01", end_date: "2026-08-05", created_at: "" },
      ],
      exceptions: [
        { id: "E1", trainee_id: "s2", status: "open",
          due_by: "2026-07-20", immediate_safety_concern: true,
          description: "x", category: "hours" },
      ],
      rtws: [],
      competencies: [],
      nameById: names,
    }, today);
    expect(items[0].kind).toBe("exception");
    expect(items[0].severity).toBe("critical");
  });

  it("marks pending leave starting soon as warning and past-start as critical", () => {
    const items = buildInbox({
      leave: [
        { id: "L1", staff_id: "s1", type: "annual", status: "pending",
          start_date: "2026-07-10", end_date: "2026-07-15", created_at: "" }, // in 3 days
        { id: "L2", staff_id: "s2", type: "study", status: "pending",
          start_date: "2026-07-04", end_date: "2026-07-05", created_at: "" }, // past
        { id: "L3", staff_id: "s1", type: "annual", status: "approved",
          start_date: "2026-07-10", end_date: "2026-07-15", created_at: "" }, // ignored
      ],
      exceptions: [],
      rtws: [],
      competencies: [],
      nameById: names,
    }, today);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("leave:L2");
    expect(items[0].severity).toBe("critical");
    expect(items[1].id).toBe("leave:L1");
    expect(items[1].severity).toBe("warning");
  });

  it("prioritises overdue RTW by days overdue", () => {
    const items = buildInbox({
      leave: [], exceptions: [],
      rtws: [
        { leave_request_id: "R1", staff_id: "s1", spell_start: "2026-06-20",
          spell_end: "2026-06-22", daysOverdue: 2 },
        { leave_request_id: "R2", staff_id: "s2", spell_start: "2026-06-01",
          spell_end: "2026-06-03", daysOverdue: 15 },
      ],
      competencies: [],
      nameById: names,
    }, today);
    expect(items[0].id).toBe("rtw:R2");
    expect(items[0].kind).toBe("rtw");
    expect(items[0].severity).toBe("critical");
  });

  it("includes expiring competencies within 60d and expired ones as critical", () => {
    const items = buildInbox({
      leave: [], exceptions: [], rtws: [],
      competencies: [
        { id: "C1", staff_id: "s1", competency_name: "Cardiac",
          expires_at: "2026-07-01" }, // expired 6d ago
        { id: "C2", staff_id: "s2", competency_name: "Paeds",
          expires_at: "2026-07-20" }, // in 13d
        { id: "C3", staff_id: "s1", competency_name: "Thoracic",
          expires_at: "2027-01-01" }, // too far → filtered
      ],
      nameById: names,
    }, today);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("competency:C1");
    expect(items[0].severity).toBe("critical");
    expect(items[1].severity).toBe("warning");
  });

  it("returns an empty list when nothing is due", () => {
    expect(buildInbox({
      leave: [], exceptions: [], rtws: [], competencies: [], nameById: names,
    }, today)).toEqual([]);
  });
});
