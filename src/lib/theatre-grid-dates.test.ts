import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isoDate, weekdayShort } from "./theatre-grid-dates";

describe("theatre-grid-dates: local-date parsing", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("parses a YYYY-MM-DD string as a local date (no UTC drift)", () => {
    // 2026-01-31 is a Saturday in the local Gregorian calendar.
    expect(isoDate("2026-01-31")).toBe("2026-01-31");
    expect(weekdayShort("2026-01-31")).toBe("Sat");
  });

  it("returns the correct weekday for a known set of dates", () => {
    const cases: Array<[string, string]> = [
      ["2026-01-31", "Sat"], // the case from the original bug report
      ["2026-02-01", "Sun"],
      ["2026-02-02", "Mon"],
      ["2026-12-25", "Fri"],
      ["2024-02-29", "Thu"], // leap day
    ];
    for (const [date, expected] of cases) {
      expect(weekdayShort(date), `weekday for ${date}`).toBe(expected);
      expect(isoDate(date), `iso for ${date}`).toBe(date);
    }
  });

  it("handles Date objects constructed with local components", () => {
    const d = new Date(2026, 0, 31); // local Jan 31, 2026
    expect(isoDate(d)).toBe("2026-01-31");
    expect(weekdayShort(d)).toBe("Sat");
  });

  it("keeps weekday label and iso date in agreement (invariant)", () => {
    // Walk a span that crosses a month boundary.
    const start = new Date(2026, 0, 28);
    const weekdayMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let i = 0; i < 14; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = isoDate(d);
      const [y, m, day] = iso.split("-").map(Number);
      const expected = weekdayMap[new Date(y, m - 1, day).getDay()];
      expect(weekdayShort(d)).toBe(expected);
    }
  });

  it("logs a warning and returns empty string for invalid input", () => {
    expect(isoDate(null)).toBe("");
    expect(isoDate(undefined)).toBe("");
    expect(isoDate("not-a-date")).toBe("");
    expect(isoDate(new Date(NaN))).toBe("");
    expect(weekdayShort(null)).toBe("");
    expect(weekdayShort("garbage")).toBe("");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[theatre-grid]"))).toBe(true);
  });
});

describe("theatre-grid-dates: cross-timezone consistency", () => {
  // Run the helpers in a fresh Node process per timezone so we actually
  // exercise different TZ settings (TZ env var must be set at process start).
  const runInTZ = (tz: string): { iso: string; weekday: string } => {
    const script = `
      process.env.TZ = ${JSON.stringify(tz)};
      const { isoDate, weekdayShort } = require(${JSON.stringify(
        path.resolve(__dirname, "theatre-grid-dates.ts"),
      )});
      // 2026-01-31 (Saturday) — the date from the original bug report.
      const out = { iso: isoDate("2026-01-31"), weekday: weekdayShort("2026-01-31") };
      process.stdout.write(JSON.stringify(out));
    `;
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      { env: { ...process.env, TZ: tz }, encoding: "utf8" },
    );
    return JSON.parse(stdout);
  };

  const timezones = [
    "UTC",
    "Europe/London",
    "Europe/Berlin",      // UTC+1 in January
    "Asia/Tokyo",         // UTC+9
    "Pacific/Auckland",   // UTC+13 in January (DST)
    "America/New_York",   // UTC-5
    "America/Los_Angeles",// UTC-8
    "Pacific/Honolulu",   // UTC-10
  ];

  for (const tz of timezones) {
    it(`returns 2026-01-31 / Sat in ${tz}`, () => {
      const { iso, weekday } = runInTZ(tz);
      expect(iso).toBe("2026-01-31");
      expect(weekday).toBe("Sat");
    });
  }
});
