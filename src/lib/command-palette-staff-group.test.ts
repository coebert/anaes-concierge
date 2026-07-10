import { describe, it, expect } from "vitest";
import { filterNavForUser, groupNav } from "./navigation";

/**
 * Command-palette placement guard for the three items that moved from the
 * "Audits & robustness" section to the "Staff" section: Absence (Bradford),
 * Leave fairness, and Wellbeing & attrition.
 *
 * The palette renders `groupNav(filterNavForUser(...))`, so exercising those
 * two pure functions with an admin-role stub is a faithful stand-in for what
 * the UI shows without spinning up React.
 */
describe("command palette — moved items appear under Staff, not Audits", () => {
  const MOVED = [
    { id: "absence", to: "/admin/absence" },
    { id: "leave-fairness", to: "/admin/leave-fairness" },
    { id: "wellbeing-admin", to: "/admin/wellbeing" },
  ] as const;

  const grouped = groupNav(
    filterNavForUser({ hasRole: (r) => r === "admin", grade: null }),
  );
  const staffIds = new Set((grouped.get("staff") ?? []).map((i) => i.id));
  const auditIds = new Set((grouped.get("audits") ?? []).map((i) => i.id));

  for (const item of MOVED) {
    it(`${item.id} is listed under the Staff group`, () => {
      const staffItem = (grouped.get("staff") ?? []).find(
        (i) => i.id === item.id,
      );
      expect(staffItem, `${item.id} missing from Staff group`).toBeDefined();
      expect(staffItem?.to).toBe(item.to);
      expect(staffIds.has(item.id)).toBe(true);
    });

    it(`${item.id} is NOT listed under the Audits & robustness group`, () => {
      expect(auditIds.has(item.id)).toBe(false);
    });
  }
});
