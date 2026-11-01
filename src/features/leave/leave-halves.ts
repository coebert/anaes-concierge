/**
 * Which halves of `date` a leave row covers (pure; safe for server routes).
 * `half_day_start="pm"` means the leave begins in the afternoon of its start
 * date; `half_day_end="am"` means it ends after the morning of its end date
 * (UI convention). A start marker of "am" / end marker of "pm" keeps only
 * that half on the boundary day.
 */
export function leaveHalvesOn(
  l: {
    start_date: string;
    end_date: string;
    half_day_start?: string | null;
    half_day_end?: string | null;
  },
  date: string,
): Set<"am" | "pm"> {
  if (date < l.start_date || date > l.end_date) return new Set();
  const h = new Set<"am" | "pm">(["am", "pm"]);
  if (date === l.start_date && l.half_day_start === "pm") h.delete("am");
  if (date === l.start_date && l.half_day_start === "am") h.delete("pm");
  if (date === l.end_date && l.half_day_end === "am") h.delete("pm");
  if (date === l.end_date && l.half_day_end === "pm") h.delete("am");
  return h;
}
