import { describe, it, expect } from "vitest";
import { NAV_GROUPS, NAV_ITEMS, type NavGroupId } from "./navigation";

/**
 * Navigation validation.
 *
 * Guards against the class of bug we hit when moving Absence / Leave fairness /
 * Wellbeing & attrition between the "audits" and "staff" menus: a route left
 * behind in the old group, or an ID accidentally duplicated across groups so
 * it renders in two places at once. These checks run on the whole NAV_ITEMS
 * table so any future move is covered, not just the three items we already
 * relocated.
 */
describe("navigation group metadata", () => {
  const validGroupIds = new Set<NavGroupId>(NAV_GROUPS.map((g) => g.id));

  it("every nav item declares a group that exists in NAV_GROUPS", () => {
    const missing = NAV_ITEMS.filter(
      (item) => !item.group || !validGroupIds.has(item.group),
    );
    expect(
      missing,
      `Items with missing/unknown group: ${missing.map((i) => i.id).join(", ")}`,
    ).toEqual([]);
  });

  it("no nav item id appears in more than one group", () => {
    const seen = new Map<string, NavGroupId>();
    const duplicates: Array<{ id: string; groups: NavGroupId[] }> = [];
    for (const item of NAV_ITEMS) {
      const prior = seen.get(item.id);
      if (prior && prior !== item.group) {
        duplicates.push({ id: item.id, groups: [prior, item.group] });
      } else {
        seen.set(item.id, item.group);
      }
    }
    expect(
      duplicates,
      `Duplicated ids across groups: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);
  });

  it("no route destination appears in more than one nav item", () => {
    const byRoute = new Map<string, string[]>();
    for (const item of NAV_ITEMS) {
      const list = byRoute.get(item.to) ?? [];
      list.push(item.id);
      byRoute.set(item.to, list);
    }
    const dupes = [...byRoute.entries()].filter(([, ids]) => ids.length > 1);
    expect(
      dupes,
      `Routes bound to multiple nav items: ${JSON.stringify(dupes)}`,
    ).toEqual([]);
  });

  it("staff/audits groups are mutually exclusive per item", () => {
    // For every item currently marked staff or audits, assert it is not
    // simultaneously classified as the other. This catches a copy-paste
    // regression where an item is added under both headings.
    const staffIds = new Set(
      NAV_ITEMS.filter((i) => i.group === "staff").map((i) => i.id),
    );
    const auditIds = new Set(
      NAV_ITEMS.filter((i) => i.group === "audits").map((i) => i.id),
    );
    const overlap = [...staffIds].filter((id) => auditIds.has(id));
    expect(overlap, `Ids in both staff and audits: ${overlap.join(", ")}`)
      .toEqual([]);
  });
});
