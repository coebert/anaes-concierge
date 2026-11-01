/**
 * iCal subscription feed: source loading (fail-closed) and pure rendering.
 * Kept separate from the route so both halves are tested with fixtures.
 *
 * Privacy: never emits assignment/theatre notes, leave reasons, decision or
 * conflict notes. Leave types are reduced by calendarLeaveLabel().
 */
import { calendarLeaveLabel } from "@/lib/calendar-feed-privacy";
import { escapeIcsText, foldIcsLine } from "@/lib/ics";
import { leaveHalvesOn } from "@/features/leave/leave-halves";

export interface FeedAssignment {
  id: string;
  session_date: string;
  session: string | null;
  duty_type: string | null;
  role_on_list: string | null;
  updated_at: string | null;
  supervisor_id: string | null;
  theatre_session_id: string | null;
}
export interface FeedLeave {
  id: string;
  type: string | null;
  start_date: string;
  end_date: string;
  half_day_start: string | null;
  half_day_end: string | null;
  updated_at: string | null;
}
export interface FeedTheatreSession {
  id: string;
  surgical_consultant: string | null;
  theatres: { name: string | null } | null;
  specialties: { name: string | null } | null;
}
export interface FeedInput {
  calendarName: string;
  assignments: FeedAssignment[];
  leave: FeedLeave[];
  theatreSessions: Map<string, FeedTheatreSession>;
  supervisors: Map<string, string>;
  now: Date;
  host: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtUtc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const fmtDate = (s: string) => s.replace(/-/g, "");
function fmtDatePlus(s: string, days: number) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}
const TITLE_CASE = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Session clock times used for timed AM/PM events (local Europe/London). */
export const AM_START = "080000";
export const AM_END_PM_START = "130000";
export const PM_END = "180000";

/**
 * DTSTART/DTEND lines for a leave row, honouring half days: a PM start
 * begins at 13:00, an AM end finishes at 13:00. Full days stay all-day.
 */
export function leaveEventTimes(l: FeedLeave): string[] {
  const first = leaveHalvesOn(l, l.start_date);
  const last = leaveHalvesOn(l, l.end_date);
  const firstFull = first.has("am") && first.has("pm");
  const lastFull = last.has("am") && last.has("pm");
  if ((firstFull && lastFull) || first.size === 0 || last.size === 0) {
    return [
      `DTSTART;VALUE=DATE:${fmtDate(l.start_date)}`,
      `DTEND;VALUE=DATE:${fmtDatePlus(l.end_date, 1)}`,
    ];
  }
  const start = first.has("am") ? AM_START : AM_END_PM_START;
  const end = last.has("pm") ? PM_END : AM_END_PM_START;
  return [
    `DTSTART;TZID=Europe/London:${fmtDate(l.start_date)}T${start}`,
    `DTEND;TZID=Europe/London:${fmtDate(l.end_date)}T${end}`,
  ];
}

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "BEGIN:STANDARD",
  "DTSTART:19711031T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZNAME:GMT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19710328T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZNAME:BST",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

export function renderCalendarFeed(input: FeedInput): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Anaes Concierge//Rota Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldIcsLine(`X-WR-CALNAME:${escapeIcsText(input.calendarName)} – Rota`),
    "X-WR-TIMEZONE:Europe/London",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    ...VTIMEZONE,
  ];
  const dtstamp = fmtUtc(input.now);
  const stamp = (updated_at: string | null) => {
    const d = updated_at ? new Date(updated_at) : input.now;
    return [`LAST-MODIFIED:${fmtUtc(d)}`, `SEQUENCE:${Math.floor(d.getTime() / 1000)}`];
  };

  for (const a of input.assignments) {
    const ts = a.theatre_session_id ? input.theatreSessions.get(a.theatre_session_id) : undefined;
    const theatre = ts?.theatres?.name ?? undefined;
    const specialty = ts?.specialties?.name ?? undefined;
    const dutyLabel = TITLE_CASE(String(a.duty_type ?? "session"));
    const title = [theatre ?? dutyLabel, ...(specialty ? [specialty] : [])].join(" – ");
    const desc: string[] = [`Duty: ${dutyLabel}`];
    if (a.session) desc.push(`Session: ${String(a.session).toUpperCase()}`);
    if (a.role_on_list) desc.push(`Role: ${TITLE_CASE(String(a.role_on_list))}`);
    if (ts?.surgical_consultant) desc.push(`Surgeon: ${ts.surgical_consultant}`);
    const sup = a.supervisor_id ? input.supervisors.get(a.supervisor_id) : undefined;
    if (sup) desc.push(`Supervisor: ${sup}`);

    lines.push("BEGIN:VEVENT", `UID:rota-${a.id}@${input.host}`, `DTSTAMP:${dtstamp}`, ...stamp(a.updated_at));
    if (a.session === "am" || a.session === "pm") {
      const d = fmtDate(a.session_date);
      const [s, e] = a.session === "am" ? [AM_START, AM_END_PM_START] : [AM_END_PM_START, PM_END];
      lines.push(`DTSTART;TZID=Europe/London:${d}T${s}`, `DTEND;TZID=Europe/London:${d}T${e}`);
    } else {
      lines.push(
        `DTSTART;VALUE=DATE:${fmtDate(a.session_date)}`,
        `DTEND;VALUE=DATE:${fmtDatePlus(a.session_date, 1)}`,
      );
    }
    lines.push(foldIcsLine(`SUMMARY:${escapeIcsText(title)}`));
    lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(desc.join("\n"))}`));
    if (theatre) lines.push(foldIcsLine(`LOCATION:${escapeIcsText(theatre)}`));
    lines.push("TRANSP:OPAQUE", "END:VEVENT");
  }

  for (const l of input.leave) {
    lines.push("BEGIN:VEVENT", `UID:leave-${l.id}@${input.host}`, `DTSTAMP:${dtstamp}`, ...stamp(l.updated_at));
    lines.push(...leaveEventTimes(l));
    lines.push(foldIcsLine(`SUMMARY:${escapeIcsText(calendarLeaveLabel(l.type))}`));
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Source loading. Any error, truncation or dangling reference => "unavailable"
// (503): a partial feed would silently delete events from subscribers.

type Res<T> = PromiseLike<{ data: T | null; error: unknown }>;
// Minimal structural view of the supabase-js query builder we use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (t: string) => any };

export type FeedOutcome =
  | { kind: "ok"; body: string }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: string };

const MAX_ROWS = 20_000;
const PAGE = 1000;

async function pageAll<T>(label: string, q: (from: number, to: number) => Res<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    if (from >= MAX_ROWS) throw new Error(`${label}: more than ${MAX_ROWS} rows`);
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: query failed`);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function buildCalendarFeedForToken(
  sb: Sb,
  token: string,
  opts: { now?: Date; host?: string } = {},
): Promise<FeedOutcome> {
  if (!token || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) return { kind: "not_found" };
  const now = opts.now ?? new Date();
  try {
    const { data: profile, error: pErr } = await sb
      .from("profiles")
      .select("id, full_name, active, left_at")
      .eq("calendar_feed_token", token)
      .maybeSingle();
    if (pErr) return { kind: "unavailable", reason: "profile lookup failed" };
    // Revocation: inactive, departed, or no longer an app member.
    if (!profile || profile.active !== true || profile.left_at) return { kind: "not_found" };
    const staffId = profile.id as string;
    const { data: roleRows, error: rErr } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", staffId)
      .limit(1);
    if (rErr) return { kind: "unavailable", reason: "membership lookup failed" };
    if (!roleRows?.length) return { kind: "not_found" };

    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 60);
    const to = new Date(now);
    to.setUTCDate(to.getUTCDate() + 400);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const [assignments, leave] = await Promise.all([
      pageAll<FeedAssignment>("assignments", (a, b) =>
        sb
          .from("rota_assignments")
          .select("id, session_date, session, duty_type, role_on_list, updated_at, supervisor_id, theatre_session_id")
          .eq("staff_id", staffId)
          .gte("session_date", fromStr)
          .lte("session_date", toStr)
          .order("session_date")
          .order("id")
          .range(a, b),
      ),
      pageAll<FeedLeave>("leave", (a, b) =>
        sb
          .from("leave_requests")
          .select("id, type, start_date, end_date, half_day_start, half_day_end, updated_at")
          .eq("staff_id", staffId)
          .eq("status", "approved")
          .gte("end_date", fromStr)
          .lte("start_date", toStr)
          .order("start_date")
          .order("id")
          .range(a, b),
      ),
    ]);

    const tsIds = [...new Set(assignments.map((a) => a.theatre_session_id).filter(Boolean))] as string[];
    const theatreSessions = new Map<string, FeedTheatreSession>();
    for (let i = 0; i < tsIds.length; i += 150) {
      const { data, error } = await sb
        .from("theatre_sessions")
        .select("id, surgical_consultant, theatres(name), specialties(name)")
        .in("id", tsIds.slice(i, i + 150));
      if (error) return { kind: "unavailable", reason: "theatre sessions failed" };
      for (const r of (data ?? []) as FeedTheatreSession[]) theatreSessions.set(r.id, r);
    }
    if (theatreSessions.size !== tsIds.length)
      return { kind: "unavailable", reason: "theatre session missing" };

    const supIds = [...new Set(assignments.map((a) => a.supervisor_id).filter(Boolean))] as string[];
    const supervisors = new Map<string, string>();
    for (let i = 0; i < supIds.length; i += 150) {
      const { data, error } = await sb
        .from("profiles")
        .select("id, full_name")
        .in("id", supIds.slice(i, i + 150));
      if (error) return { kind: "unavailable", reason: "supervisors failed" };
      for (const r of (data ?? []) as { id: string; full_name: string | null }[])
        supervisors.set(r.id, r.full_name ?? "");
    }
    if (supervisors.size !== supIds.length)
      return { kind: "unavailable", reason: "supervisor missing" };

    return {
      kind: "ok",
      body: renderCalendarFeed({
        calendarName: profile.full_name ?? "My",
        assignments,
        leave,
        theatreSessions,
        supervisors,
        now,
        host: opts.host ?? "anaes-concierge.lovable.app",
      }),
    };
  } catch {
    return { kind: "unavailable", reason: "source failed" };
  }
}
