import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "./navigation";

/**
 * Regression: Absence (Bradford), Leave fairness, and Wellbeing &
 * attrition were moved out of the "Audits & robustness" menu into the
 * "Staff" menu. Guard both directions so a future refactor cannot
 * silently reintroduce them under audits.
 */
const MOVED_IDS = ["absence", "leave-fairness", "wellbeing-admin"] as const;

describe("navigation — moved staff items", () => {
  it.each(MOVED_IDS)("%s is grouped under staff", (id) => {
    const item = NAV_ITEMS.find((i) => i.id === id);
    expect(item, `missing NAV_ITEMS entry: ${id}`).toBeDefined();
    expect(item!.group).toBe("staff");
  });

  it("none of the moved items are grouped under audits", () => {
    const stillInAudits = NAV_ITEMS.filter(
      (i) => MOVED_IDS.includes(i.id as (typeof MOVED_IDS)[number]) && i.group === "audits",
    );
    expect(stillInAudits).toEqual([]);
  });

  it("routes match the expected destinations", () => {
    const byId = new Map(NAV_ITEMS.map((i) => [i.id, i.to]));
    expect(byId.get("absence")).toBe("/admin/absence");
    expect(byId.get("leave-fairness")).toBe("/admin/leave-fairness");
    expect(byId.get("wellbeing-admin")).toBe("/admin/wellbeing");
  });
});
