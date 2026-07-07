import { describe, it, expect } from "vitest";
import { formatDateTimeGB } from "./utils";

/**
 * `formatDateTimeGB` must always render the date portion as DD/MM/YYYY
 * (British convention), regardless of the user's browser locale. The
 * implementation pins the formatter to `en-GB` with 2-digit day, month, and
 * numeric year — these tests lock that contract in so a future refactor
 * cannot silently drop back to the runtime default locale (which would
 * render as MM/DD/YYYY for US users).
 *
 * We assert on the leading date portion only. The trailing time portion is
 * rendered in the runtime's local timezone, so its exact value depends on
 * where the test runs; the date-part contract is what the user cares about.
 */

const DATE_PART_RE = /^(\d{2})\/(\d{2})\/(\d{4})/;

function datePartOf(s: string): { dd: string; mm: string; yyyy: string } {
  const m = DATE_PART_RE.exec(s);
  if (!m) throw new Error(`Not DD/MM/YYYY-prefixed: ${JSON.stringify(s)}`);
  return { dd: m[1], mm: m[2], yyyy: m[3] };
}

describe("formatDateTimeGB", () => {
  it("returns em-dash for null / undefined / empty input", () => {
    expect(formatDateTimeGB(null)).toBe("—");
    expect(formatDateTimeGB(undefined)).toBe("—");
    expect(formatDateTimeGB("")).toBe("—");
  });

  it("returns em-dash for invalid input", () => {
    expect(formatDateTimeGB("not a date")).toBe("—");
    expect(formatDateTimeGB(new Date("nope"))).toBe("—");
  });

  it("renders an ISO timestamp with a DD/MM/YYYY date prefix", () => {
    // 2026-03-07T09:15:00Z — pick a day where DD !== MM so an accidental
    // MM/DD/YYYY output would be caught (07/03 vs 03/07).
    const out = formatDateTimeGB("2026-03-07T09:15:00Z");
    const { dd, mm, yyyy } = datePartOf(out);
    // Depending on the runtime timezone, the local calendar day may be
    // 2026-03-07 or 2026-03-06 (in timezones west of UTC at that instant),
    // but the ordering must always be DD/MM/YYYY with month = 03.
    expect(mm).toBe("03");
    expect(yyyy).toBe("2026");
    expect(["06", "07"]).toContain(dd);
  });

  it("renders a Date instance with a DD/MM/YYYY date prefix", () => {
    // Local-midnight Date — no timezone drift can shift the calendar day.
    const d = new Date(2026, 10, 4, 8, 30); // 4 Nov 2026, 08:30 local
    const out = formatDateTimeGB(d);
    const { dd, mm, yyyy } = datePartOf(out);
    expect(dd).toBe("04");
    expect(mm).toBe("11");
    expect(yyyy).toBe("2026");
  });

  it("zero-pads single-digit days and months", () => {
    const out = formatDateTimeGB(new Date(2026, 0, 3, 12, 0)); // 3 Jan 2026
    const { dd, mm, yyyy } = datePartOf(out);
    expect(dd).toBe("03");
    expect(mm).toBe("01");
    expect(yyyy).toBe("2026");
  });

  it("puts day before month for a date where DD > 12 (unambiguous)", () => {
    // 25/12/2026 — a US-locale (MM/DD/YYYY) render would be "12/25/2026"
    // and fail the leading DD/MM regex, catching a locale regression.
    const out = formatDateTimeGB(new Date(2026, 11, 25, 10, 0));
    const { dd, mm, yyyy } = datePartOf(out);
    expect(dd).toBe("25");
    expect(mm).toBe("12");
    expect(yyyy).toBe("2026");
  });

  it("appends a time portion after the date", () => {
    const out = formatDateTimeGB(new Date(2026, 5, 15, 14, 5));
    // Expect "DD/MM/YYYY, HH:mm" — a comma-and-space separator is the
    // en-GB default when both dateStyle and timeStyle are requested.
    expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4},\s\d{2}:\d{2}$/);
  });
});
