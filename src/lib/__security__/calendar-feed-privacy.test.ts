import { describe, expect, it } from "vitest";
import { calendarLeaveLabel } from "@/lib/calendar-feed-privacy";
import { readFileSync } from "node:fs";

describe("calendar feed least disclosure", () => {
  it("hides health/family leave types", () => {
    for (const t of [
      "sick",
      "compassionate",
      "parental",
      "carers",
      "other",
      "jury",
      "industrial",
      null,
    ]) {
      expect(calendarLeaveLabel(t)).toBe("Leave (approved)");
    }
  });
  it("keeps non-sensitive labels so existing calendars stay readable", () => {
    expect(calendarLeaveLabel("annual")).toBe("Annual Leave (approved)");
    expect(calendarLeaveLabel("study")).toBe("Study Leave (approved)");
  });
  it("feed route never selects leave reasons and is not publicly cacheable", () => {
    const src = readFileSync("src/routes/api/public/calendar/$token.ts", "utf8");
    expect(src).not.toMatch(/half_day_end, reason/);
    expect(src).toContain('"Cache-Control": "private, no-store, max-age=0"');
  });
});
