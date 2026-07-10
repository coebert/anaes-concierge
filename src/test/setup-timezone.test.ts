import { describe, expect, it } from "vitest";

describe("shared test setup", () => {
  it("forces process.env.TZ to UTC", () => {
    expect(process.env.TZ).toBe("UTC");
  });

  it("makes Date use UTC as the local timezone", () => {
    // getTimezoneOffset() returns 0 iff local time == UTC.
    expect(new Date("2026-07-10T00:00:00Z").getTimezoneOffset()).toBe(0);
    // Local-string parsing must match UTC-string parsing.
    expect(new Date("2026-07-10T00:00:00").getTime()).toBe(
      Date.UTC(2026, 6, 10, 0, 0, 0),
    );
  });
});
