import { computeBradfordFactor, type BradfordSpell, type BradfordResult } from "@/lib/bradford-factor";

export type SickSpellRow = {
  id: string;
  staff_id: string;
  start_date: string;
  end_date: string;
  half_day_start: string | null;
  half_day_end: string | null;
  status: string;
  type: string;
};

export type RtwRow = {
  leave_request_id: string;
  conducted_at: string;
  fitness_confirmed: boolean;
  follow_up_required: boolean;
  follow_up_date: string | null;
};

export type SickSpellSummary = {
  id: string;
  start_date: string;
  end_date: string;
  days: number;
  rtwStatus: "not_started" | "completed" | "overdue";
  rtwFollowUp: string | null;
  postWeekend: boolean; // spell begins on Monday
  daysSinceLast: number | null;
};

export type AbsenceSummary = {
  bradford: BradfordResult;
  spells: SickSpellSummary[];
  openRtwCount: number;
  overdueRtwCount: number;
  frequentShortSpells: boolean; // ≥3 spells ≤2 days each in last 6 months
  lastSpellDaysAgo: number | null;
};

/** Business days between end-of-spell and today; a rough "days late" figure. */
function workingDaysSince(dateIso: string, today: Date): number {
  const [y, m, d] = dateIso.split("-").map((n) => parseInt(n, 10));
  const from = new Date(Date.UTC(y, m - 1, d));
  let count = 0;
  const cursor = new Date(from);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= today) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function dayCount(spell: SickSpellRow): number {
  const [ay, am, ad] = spell.start_date.split("-").map((n) => parseInt(n, 10));
  const [by, bm, bd] = spell.end_date.split("-").map((n) => parseInt(n, 10));
  const s = Date.UTC(ay, am - 1, ad);
  const e = Date.UTC(by, bm - 1, bd);
  let days = Math.round((e - s) / 86_400_000) + 1;
  if (spell.half_day_start) days -= 0.5;
  if (spell.half_day_end && s !== e) days -= 0.5;
  return Math.max(0, days);
}

/**
 * A Return-to-Work interview is overdue if the sickness has ended AND
 * more than 3 working days have passed with no interview logged.
 */
const RTW_OVERDUE_WORKING_DAYS = 3;

export function summariseAbsence(
  spells: SickSpellRow[],
  rtws: RtwRow[],
  referenceDate: Date = new Date(),
): AbsenceSummary {
  const approved = spells
    .filter((s) => s.status === "approved" && s.type === "sick")
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const rtwByLeave = new Map<string, RtwRow>();
  for (const r of rtws) rtwByLeave.set(r.leave_request_id, r);

  const today = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  const todayIso = today.toISOString().slice(0, 10);

  const bradfordInput: BradfordSpell[] = approved.map((s) => ({
    start_date: s.start_date,
    end_date: s.end_date,
    half_day_start: !!s.half_day_start,
    half_day_end: !!s.half_day_end,
  }));
  const bradford = computeBradfordFactor(bradfordInput, today);

  let lastEnd: string | null = null;
  const spellSummaries: SickSpellSummary[] = approved.map((s) => {
    const rtw = rtwByLeave.get(s.id);
    const endsInPast = s.end_date < todayIso;
    let rtwStatus: SickSpellSummary["rtwStatus"] = "not_started";
    if (rtw) rtwStatus = "completed";
    else if (endsInPast && workingDaysSince(s.end_date, today) > RTW_OVERDUE_WORKING_DAYS)
      rtwStatus = "overdue";

    const start = new Date(Date.UTC(
      ...(s.start_date.split("-").map((n) => parseInt(n, 10)) as [number, number, number]),
    ) as unknown as number);
    const dow = new Date(s.start_date + "T00:00:00Z").getUTCDay();

    const daysSinceLast = lastEnd
      ? Math.round(
          (Date.UTC(
            ...(s.start_date.split("-").map((n) => parseInt(n, 10)) as [number, number, number]),
          ) -
            Date.UTC(
              ...(lastEnd.split("-").map((n) => parseInt(n, 10)) as [number, number, number]),
            )) /
            86_400_000,
        )
      : null;
    lastEnd = s.end_date;

    return {
      id: s.id,
      start_date: s.start_date,
      end_date: s.end_date,
      days: dayCount(s),
      rtwStatus,
      rtwFollowUp: rtw?.follow_up_required ? rtw.follow_up_date : null,
      postWeekend: dow === 1,
      daysSinceLast,
      _dummy: start,
    } as SickSpellSummary;
  });

  const openRtwCount = spellSummaries.filter((s) => s.rtwStatus !== "completed").length;
  const overdueRtwCount = spellSummaries.filter((s) => s.rtwStatus === "overdue").length;

  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const recentShort = spellSummaries.filter(
    (s) => s.start_date >= sixMonthsAgo.toISOString().slice(0, 10) && s.days <= 2,
  );
  const frequentShortSpells = recentShort.length >= 3;

  const lastSpellDaysAgo = lastEnd
    ? Math.round((today.getTime() - Date.UTC(
        ...(lastEnd as string).split("-").map((n) => parseInt(n, 10)) as unknown as [number, number, number],
      )) / 86_400_000)
    : null;

  return {
    bradford,
    spells: spellSummaries.reverse(), // newest first for display
    openRtwCount,
    overdueRtwCount,
    frequentShortSpells,
    lastSpellDaysAgo,
  };
}
