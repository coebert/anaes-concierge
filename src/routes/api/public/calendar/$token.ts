import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { calendarLeaveLabel } from "@/lib/calendar-feed-privacy";
import { escapeIcsText, foldIcsLine } from "@/lib/ics";

const unavailable = () =>
  new Response("Calendar temporarily unavailable", {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "300" },
  });

// Apple Calendar / iCal subscription feed.
// URL: /api/public/calendar/<token>.ics
// The token is the auth — keep it secret.

function admin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}
// Format a UTC instant as "YYYYMMDDTHHMMSSZ"
function fmtUtc(d: Date) {
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}
function fmtDate(yyyy_mm_dd: string) {
  return yyyy_mm_dd.replace(/-/g, "");
}
function fmtDatePlus(yyyy_mm_dd: string, days: number) {
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return (
    dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate())
  );
}
const escapeText = escapeIcsText;
const fold = foldIcsLine;

const TITLE_CASE = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const Route = createFileRoute("/api/public/calendar/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const raw = (params as unknown as Record<string, string>).token ?? "";
        // Tolerate a trailing .ics suffix so old links keep working.
        const token = raw.replace(/\.ics$/i, "");
        if (!token || token.length < 32) {
          return new Response("Not found", { status: 404 });
        }
        const sb = admin();
        const { data: profile, error: pErr } = await sb
          .from("profiles")
          .select("id, full_name, active")
          .eq("calendar_feed_token", token)
          .maybeSingle();
        if (pErr) return unavailable();
        // Revocation: departed/inactive staff or accounts without any app role
        // lose the feed even if they still hold an old link.
        if (!profile || profile.active !== true) return new Response("Not found", { status: 404 });
        const staffId = profile.id as string;
        const { data: roleRows, error: rErr } = await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", staffId)
          .limit(1);
        if (rErr) return unavailable();
        if (!roleRows?.length) return new Response("Not found", { status: 404 });

        // 60 days back, 13 months forward so a full year of on-calls shows.
        const today = new Date();
        const from = new Date(today);
        from.setUTCDate(from.getUTCDate() - 60);
        const to = new Date(today);
        to.setUTCDate(to.getUTCDate() + 400);
        const fromStr = from.toISOString().slice(0, 10);
        const toStr = to.toISOString().slice(0, 10);

        // Page through rows — a year of AM/PM/on-call rows exceeds the
        // default 1000-row response cap, which silently truncated the feed.
        const fetchAllAssignments = async () => {
          const all: any[] = [];
          const PAGE = 1000;
          for (let offset = 0; offset < 20000; offset += PAGE) {
            const { data, error } = await sb
              .from("rota_assignments")
              .select(
                "id, session_date, session, duty_type, role_on_list, notes, updated_at, supervisor_id, theatre_session_id",
              )
              .eq("staff_id", staffId)
              .gte("session_date", fromStr)
              .lte("session_date", toStr)
              .order("session_date")
              .order("id")
              .range(offset, offset + PAGE - 1);
            if (error) return { data: all, error };
            if (offset + PAGE >= 20000 && data && data.length === PAGE) {
              return { data: all, error: new Error("too many rows") };
            }
            all.push(...(data ?? []));
            if (!data || data.length < PAGE) break;
          }
          return { data: all, error: null };
        };

        const [assignmentsRes, leaveRes] = await Promise.all([
          fetchAllAssignments(),
          sb
            .from("leave_requests")
            .select(
              "id, type, status, start_date, end_date, half_day_start, half_day_end, updated_at",
            )
            .eq("staff_id", staffId)
            .eq("status", "approved")
            .gte("end_date", fromStr)
            .lte("start_date", toStr),
        ]);
        // Fail closed: a partial feed would silently delete events from
        // subscribers' calendars, so any source error returns 503 instead.
        if (assignmentsRes.error || leaveRes.error) return unavailable();

        // Resolve theatre sessions in batch
        const tsIds = Array.from(
          new Set(
            (assignmentsRes.data ?? [])
              .map((a: any) => a.theatre_session_id)
              .filter(Boolean),
          ),
        ) as string[];
        let tsMap = new Map<string, any>();
        if (tsIds.length) {
          for (let i = 0; i < tsIds.length; i += 150) {
            const { data: ts, error: tsErr } = await sb
              .from("theatre_sessions")
              .select(
                "id, theatre_id, specialty_id, surgical_consultant, notes, theatres(name), specialties(name)",
              )
              .in("id", tsIds.slice(i, i + 150));
            if (tsErr) return unavailable();
            (ts ?? []).forEach((row: any) => tsMap.set(row.id, row));
          }
        }
        // Resolve supervisor names
        const supIds = Array.from(
          new Set(
            (assignmentsRes.data ?? [])
              .map((a: any) => a.supervisor_id)
              .filter(Boolean),
          ),
        ) as string[];
        let supMap = new Map<string, string>();
        if (supIds.length) {
          const { data: sups, error: supErr } = await sb
            .from("profiles")
            .select("id, full_name")
            .in("id", supIds);
          if (supErr) return unavailable();
          (sups ?? []).forEach((p: any) => supMap.set(p.id, p.full_name));
        }

        const lines: string[] = [];
        lines.push("BEGIN:VCALENDAR");
        lines.push("VERSION:2.0");
        lines.push("PRODID:-//Anaes Concierge//Rota Feed//EN");
        lines.push("CALSCALE:GREGORIAN");
        lines.push("METHOD:PUBLISH");
        lines.push(
          fold(
            `X-WR-CALNAME:${escapeText(profile.full_name ?? "My")} – Rota`,
          ),
        );
        lines.push("X-WR-TIMEZONE:Europe/London");
        // 15-minute hint — Apple Calendar uses this to pick a poll cadence.
        lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT15M");
        lines.push("X-PUBLISHED-TTL:PT15M");

        // Europe/London VTIMEZONE (sufficient for current DST rules)
        lines.push(
          [
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
          ].join("\r\n"),
        );

        const dtstamp = fmtUtc(new Date());
        const host = "anaes-concierge.lovable.app";

        for (const a of assignmentsRes.data ?? []) {
          const ts = a.theatre_session_id ? tsMap.get(a.theatre_session_id) : null;
          const theatre = ts?.theatres?.name as string | undefined;
          const specialty = ts?.specialties?.name as string | undefined;
          const dutyLabel = TITLE_CASE(String(a.duty_type ?? "session"));

          const titleParts: string[] = [];
          if (theatre) titleParts.push(theatre);
          else titleParts.push(dutyLabel);
          if (specialty) titleParts.push(specialty);
          const title = titleParts.join(" – ");

          const descLines: string[] = [];
          descLines.push(`Duty: ${dutyLabel}`);
          if (a.session) descLines.push(`Session: ${String(a.session).toUpperCase()}`);
          if (a.role_on_list) descLines.push(`Role: ${TITLE_CASE(String(a.role_on_list))}`);
          if (ts?.surgical_consultant) descLines.push(`Surgeon: ${ts.surgical_consultant}`);
          if (a.supervisor_id && supMap.get(a.supervisor_id))
            descLines.push(`Supervisor: ${supMap.get(a.supervisor_id)}`);
          if (a.notes) descLines.push(`Notes: ${a.notes}`);

          const uid = `rota-${a.id}@${host}`;
          const updatedDate = a.updated_at ? new Date(a.updated_at) : new Date();
          const updated = fmtUtc(updatedDate);
          // SEQUENCE forces clients to overwrite the cached event on next poll
          // whenever the underlying row has been modified.
          const sequence = Math.floor(updatedDate.getTime() / 1000);

          lines.push("BEGIN:VEVENT");
          lines.push(`UID:${uid}`);
          lines.push(`DTSTAMP:${dtstamp}`);
          lines.push(`LAST-MODIFIED:${updated}`);
          lines.push(`SEQUENCE:${sequence}`);

          const isAm = a.session === "am";
          const isPm = a.session === "pm";
          if (isAm || isPm) {
            const startH = isAm ? "080000" : "130000";
            const endH = isAm ? "130000" : "180000";
            const d = fmtDate(a.session_date);
            lines.push(`DTSTART;TZID=Europe/London:${d}T${startH}`);
            lines.push(`DTEND;TZID=Europe/London:${d}T${endH}`);
          } else {
            // All-day for on-call / nights / NWD / etc.
            lines.push(`DTSTART;VALUE=DATE:${fmtDate(a.session_date)}`);
            lines.push(`DTEND;VALUE=DATE:${fmtDatePlus(a.session_date, 1)}`);
          }
          lines.push(fold(`SUMMARY:${escapeText(title)}`));
          if (descLines.length) lines.push(fold(`DESCRIPTION:${escapeText(descLines.join("\n"))}`));
          if (theatre) lines.push(fold(`LOCATION:${escapeText(theatre)}`));
          lines.push("TRANSP:OPAQUE");
          lines.push("END:VEVENT");
        }

        for (const l of leaveRes.data ?? []) {
          const uid = `leave-${l.id}@${host}`;
          const updatedDate = l.updated_at ? new Date(l.updated_at) : new Date();
          const updated = fmtUtc(updatedDate);
          const sequence = Math.floor(updatedDate.getTime() / 1000);
          const typeLabel = calendarLeaveLabel(l.type);
          lines.push("BEGIN:VEVENT");
          lines.push(`UID:${uid}`);
          lines.push(`DTSTAMP:${dtstamp}`);
          lines.push(`LAST-MODIFIED:${updated}`);
          lines.push(`SEQUENCE:${sequence}`);
          lines.push(`DTSTART;VALUE=DATE:${fmtDate(l.start_date)}`);
          lines.push(`DTEND;VALUE=DATE:${fmtDatePlus(l.end_date, 1)}`);
          lines.push(fold(`SUMMARY:${escapeText(typeLabel)}`));
          lines.push("TRANSP:TRANSPARENT");
          lines.push("END:VEVENT");
        }

        lines.push("END:VCALENDAR");
        const body = lines.join("\r\n") + "\r\n";

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            // The URL is a bearer credential: never let shared caches store it.
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Disposition": `inline; filename="rota.ics"`,
          },
        });
      },
    },
  },
});
