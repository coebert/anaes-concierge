// Synthetic test helper: N weekday AM rota rows before `from`, so a fixture
// clears the wellbeing coverage gate without adding harm to any driver
// (no nights, evenings or weekends).
export function weekdayAmRows(
  staffId: string,
  from: Date = new Date(),
  count = 12,
): Array<{ staff_id: string; session_date: string; session: string }> {
  const out: Array<{ staff_id: string; session_date: string; session: string }> = [];
  let t = Date.parse(from.toISOString().slice(0, 10) + "T00:00:00Z") - 7 * 86_400_000;
  while (out.length < count) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push({ staff_id: staffId, session_date: d.toISOString().slice(0, 10), session: "am" });
    }
    t -= 86_400_000;
  }
  return out;
}
