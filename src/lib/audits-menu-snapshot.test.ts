import { describe, it, expect } from "vitest";
import { NAV_ITEMS } from "./navigation";

/**
 * Snapshot guard for the "Audits & robustness" menu group.
 *
 * After moving Absence (Bradford), Leave fairness, and Wellbeing & attrition
 * to the Staff group, we lock the exact contents of the audits group so any
 * future re-introduction of these three items (by ID, label, or route) fails
 * loudly in CI. The forbidden list is asserted explicitly in addition to the
 * snapshot so a bulk snapshot update cannot silently re-add them.
 */
describe("audits/robustness menu snapshot", () => {
  const FORBIDDEN_IDS = ["absence", "leave-fairness", "wellbeing-admin"] as const;
  const FORBIDDEN_ROUTES = [
    "/admin/absence",
    "/admin/leave-fairness",
    "/admin/wellbeing",
  ] as const;
  const FORBIDDEN_LABELS = [
    "Absence (Bradford)",
    "Leave fairness",
    "Wellbeing & attrition",
  ] as const;

  const auditItems = NAV_ITEMS.filter((i) => i.group === "audits");

  it("does not contain any of the three moved items (by id, route, or label)", () => {
    const offending = auditItems.filter(
      (i) =>
        (FORBIDDEN_IDS as readonly string[]).includes(i.id) ||
        (FORBIDDEN_ROUTES as readonly string[]).includes(i.to) ||
        (FORBIDDEN_LABELS as readonly string[]).includes(i.label),
    );
    expect(
      offending,
      `Forbidden items resurfaced under audits: ${offending
        .map((i) => `${i.id} (${i.to})`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("matches the locked snapshot of audits group members", () => {
    // The legacy "audits" umbrella group was split into Robustness,
    // Analytics, and Compliance. No items should remain assigned to the
    // legacy id; each former member now lives in one of the three
    // focused groups (see NAV_ITEMS in src/lib/navigation.ts).
    const shape = auditItems.map((i) => ({ id: i.id, label: i.label, to: i.to }));
    expect(shape).toMatchInlineSnapshot(`[]`);
  });
});
