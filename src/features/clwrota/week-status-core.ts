/** Pure week-status helpers shared by the import (server) and the app (browser). */
export type WeekStatusCode = "published" | "setup" | "not_setup" | "mixed" | "unknown" | "other";

/** Feed value → code. `null` for blank/absent. */
export function normaliseRotaStatus(
  raw: unknown,
): Exclude<WeekStatusCode, "mixed" | "unknown"> | null {
  if (typeof raw !== "string") return null;
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  if (!k) return null;
  if (k === "published") return "published";
  if (k === "setup" || k === "set up") return "setup";
  if (k === "not setup" || k === "not set up") return "not_setup";
  return "other";
}

/** Monday (ISO week start) of a yyyy-mm-dd date, as yyyy-mm-dd. */
export function isoWeekStart(dateIso: string): string {
  const [y, m, d] = dateIso.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay(); // 0 Sun … 6 Sat
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}
