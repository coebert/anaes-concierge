/**
 * Synthetic fixture mirroring the shape of the 2026/27 appraisal-year bug:
 * 201 credited AM/PM entries over 119 distinct dates (4 of them extra
 * sessions on 2 otherwise unworked dates), where summing each specialty's own
 * day count gave 149. Synthetic ids and labels only; used by
 * tests and the print check.
 */
import type { ListInfo, PracticeRow } from "./practice-summary";

export const FIXTURE_ME = "11111111-1111-1111-1111-111111111111";

function weekdays(fromIso: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${fromIso}T12:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function dayCountFixture(): {
  rows: PracticeRow[];
  lists: Map<string, ListInfo>;
  from: string;
  to: string;
} {
  const lists = new Map<string, ListInfo>([
    ["LA", { specialty: "Synthetic Gynae", location: "Synthetic Theatre 1" }],
    ["LB", { specialty: "Synthetic Ortho", location: "Synthetic Theatre 2" }],
  ]);
  let n = 0;
  const row = (
    date: string,
    session: string,
    list: string | null,
    o: Partial<PracticeRow> = {},
  ) => ({
    id: `fx${++n}`,
    staff_id: FIXTURE_ME,
    session_date: date,
    session,
    duty_type: "theatre",
    extra_type: null,
    pa_credit: null,
    attending_consultant_ids: null,
    theatre_session_id: list,
    source: "clwrota",
    locally_modified: false,
    clwrota_external_id: `fx|${date}|${session}`,
    ...o,
  });
  const dates = weekdays("2030-04-01", 120);
  const rows: PracticeRow[] = [];
  // 32 dates: AM in one specialty, PM in another (counted once each date).
  for (const d of dates.slice(0, 32)) rows.push(row(d, "am", "LA"), row(d, "pm", "LB"));
  // 48 dates: AM + PM in the same specialty.
  for (const d of dates.slice(32, 80)) rows.push(row(d, "am", "LA"), row(d, "pm", "LA"));
  // 37 dates: a single AM.
  for (const d of dates.slice(80, 117)) rows.push(row(d, "am", "LB"));
  // 2 dates with only extra (WLI) AM + PM sessions: still days with daytime work.
  for (const d of dates.slice(117, 119))
    rows.push(row(d, "am", "LA", { extra_type: "wli" }), row(d, "pm", "LA", { extra_type: "wli" }));
  // Not daytime work: an evening-only on-call date.
  rows.push(row(dates[119], "eve", null, { duty_type: "general_consultant_oncall" }));
  return { rows, lists, from: "2030-04-01", to: "2031-03-31" };
}
