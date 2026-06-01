import { parseDateLocal, toISODateLocal } from "@/lib/utils";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type DayShort = (typeof DAY_SHORT)[number];

/**
 * Defensive local-date ISO formatter for the theatre grid.
 * Always treats the input as a LOCAL date (never UTC) and logs a warning
 * if an invalid Date / string is encountered, returning "" so downstream
 * queries fail loudly rather than silently using a wrong date.
 */
export function isoDate(d: Date | string | null | undefined): string {
  const parsed = d instanceof Date ? d : parseDateLocal(d);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    console.warn("[theatre-grid] invalid date encountered:", d);
    return "";
  }
  return toISODateLocal(parsed);
}

/**
 * Weekday label derived from the same local-date interpretation as `isoDate`,
 * so the displayed weekday never drifts off the displayed date.
 */
export function weekdayShort(d: Date | string | null | undefined): string {
  const parsed = d instanceof Date ? d : parseDateLocal(d);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    console.warn("[theatre-grid] invalid date for weekday label:", d);
    return "";
  }
  // Re-parse through the local-ISO round-trip so the label always agrees
  // with what isoDate(d) returns.
  const local = parseDateLocal(toISODateLocal(parsed));
  return local ? DAY_SHORT[local.getDay()] : "";
}
