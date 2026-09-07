// Server-only builder + sender for the 06:30 "what am I doing today" push.
//
// Rules:
//   - Only people with a push subscription are considered.
//   - A digest is only sent when the person actually has something rostered
//     that day: a clinical session, an on-call, or SPA. Days off, and days
//     where the only row is non-clinical/leave, produce no notification.
//   - One digest per person per day (deduplicated in `daily_digest_log`).
import webpush from "web-push";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { formatDateWithWeekdayGB } from "@/lib/utils";

type AssignmentRow = {
  id: string;
  staff_id: string;
  session: string | null;
  duty_type: string | null;
  role_on_list: string | null;
  notes: string | null;
  theatre_session_id: string | null;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Duty types that do not count as "working or on SPA". */
const NON_WORKING_DUTY_TYPES = new Set(["non_clinical"]);

const DUTY_LABELS: Record<string, string> = {
  theatre: "Theatre",
  consultant_in_charge: "Consultant in charge",
  obstetrics: "Obstetrics",
  obstetrics_2nd: "Obstetrics (2nd on)",
  icu_trainee: "Intensive care",
  icu_ct2_plus: "Intensive care",
  icu_consultant_oncall: "ICU on-call",
  general_consultant_oncall: "General on-call",
  registrar_oncall: "Registrar on-call",
  sho_oncall: "SHO on-call",
  nhh_oncall: "NHH on-call",
  spa: "SPA",
  admin: "Admin",
  teaching: "Teaching",
  medical_examiner: "Medical examiner",
  non_clinical: "Non-clinical",
};

function halfLabel(session: string | null): string {
  const s = (session ?? "").toLowerCase();
  if (s === "am") return "AM";
  if (s === "pm") return "PM";
  if (s === "eve") return "Evening";
  if (s === "night") return "Night";
  return s ? s.toUpperCase() : "";
}

function configureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:notifications@example.com";
  if (!pub || !priv) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, pub, priv);
}

/** Today's date in Europe/London as YYYY-MM-DD. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Current hour (0-23) in Europe/London. */
export function londonHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
}

export function describeAssignment(
  row: AssignmentRow,
  theatreName?: string,
  specialty?: string,
): string {
  const half = halfLabel(row.session);
  const duty = DUTY_LABELS[row.duty_type ?? ""] ?? (row.duty_type ?? "Session").replace(/_/g, " ");
  const what = theatreName
    ? `${theatreName}${specialty ? ` (${specialty})` : ""}`
    : duty;
  return half ? `${half}: ${what}` : what;
}

const HALF_ORDER: Record<string, number> = { am: 0, pm: 1, eve: 2, night: 3 };

export async function dispatchDailyDigests(options?: { date?: string; force?: boolean }): Promise<{
  date: string;
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
  pruned: number;
}> {
  configureVapid();
  const date = options?.date ?? londonToday();

  // 1. Everyone with a push subscription.
  const { data: subsData, error: subsErr } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth");
  if (subsErr) throw subsErr;
  const subs = (subsData ?? []) as SubscriptionRow[];
  if (subs.length === 0)
    return { date, candidates: 0, sent: 0, skipped: 0, failed: 0, pruned: 0 };

  const subsByUser = new Map<string, SubscriptionRow[]>();
  for (const s of subs) {
    const arr = subsByUser.get(s.user_id) ?? [];
    arr.push(s);
    subsByUser.set(s.user_id, arr);
  }
  const userIds = Array.from(subsByUser.keys());

  // 2. Already sent today?
  let alreadySent = new Set<string>();
  if (!options?.force) {
    const { data: logged } = await supabaseAdmin
      .from("daily_digest_log")
      .select("staff_id")
      .eq("digest_date", date)
      .in("staff_id", userIds);
    alreadySent = new Set((logged ?? []).map((r) => r.staff_id as string));
  }
  const targets = userIds.filter((id) => !alreadySent.has(id));
  if (targets.length === 0)
    return { date, candidates: 0, sent: 0, skipped: userIds.length, failed: 0, pruned: 0 };

  // 3. Today's rota rows for those people.
  const { data: rowsData, error: rowsErr } = await supabaseAdmin
    .from("rota_assignments")
    .select("id, staff_id, session, duty_type, role_on_list, notes, theatre_session_id")
    .eq("session_date", date)
    .in("staff_id", targets);
  if (rowsErr) throw rowsErr;
  const rows = ((rowsData ?? []) as AssignmentRow[]).filter(
    (r) => !NON_WORKING_DUTY_TYPES.has(r.duty_type ?? ""),
  );

  const byStaff = new Map<string, AssignmentRow[]>();
  for (const r of rows) {
    const arr = byStaff.get(r.staff_id) ?? [];
    arr.push(r);
    byStaff.set(r.staff_id, arr);
  }
  if (byStaff.size === 0)
    return { date, candidates: 0, sent: 0, skipped: targets.length, failed: 0, pruned: 0 };

  // 4. Anyone on approved leave for the whole day is not "due to be working".
  const { data: leaveData } = await supabaseAdmin
    .from("leave_requests")
    .select("staff_id")
    .eq("status", "approved")
    .lte("start_date", date)
    .gte("end_date", date)
    .in("staff_id", Array.from(byStaff.keys()));
  const onLeave = new Set((leaveData ?? []).map((r) => r.staff_id as string));

  // 5. Theatre names / specialties for nicer wording.
  const tsIds = Array.from(
    new Set(rows.map((r) => r.theatre_session_id).filter((v): v is string => !!v)),
  );
  const theatreById = new Map<string, { theatre?: string; specialty?: string }>();
  if (tsIds.length > 0) {
    const { data: ts } = await supabaseAdmin
      .from("theatre_sessions")
      .select("id, theatres(name), specialties(name)")
      .in("id", tsIds);
    for (const row of (ts ?? []) as unknown as Array<{
      id: string;
      theatres: { name: string } | null;
      specialties: { name: string } | null;
    }>) {
      theatreById.set(row.id, {
        theatre: row.theatres?.name ?? undefined,
        specialty: row.specialties?.name ?? undefined,
      });
    }
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  let skipped = 0;
  let candidates = 0;
  const logEntries: Array<{ staff_id: string; digest_date: string; status: string }> = [];

  for (const [staffId, staffRows] of byStaff) {
    if (onLeave.has(staffId)) {
      skipped += 1;
      logEntries.push({ staff_id: staffId, digest_date: date, status: "on_leave" });
      continue;
    }
    candidates += 1;
    const ordered = [...staffRows].sort(
      (a, b) =>
        (HALF_ORDER[(a.session ?? "").toLowerCase()] ?? 9) -
        (HALF_ORDER[(b.session ?? "").toLowerCase()] ?? 9),
    );
    const lines = ordered.map((r) => {
      const ts = r.theatre_session_id ? theatreById.get(r.theatre_session_id) : undefined;
      return describeAssignment(r, ts?.theatre, ts?.specialty);
    });
    const payload = JSON.stringify({
      title: `Today — ${formatDateWithWeekdayGB(date)}`,
      body: lines.join("\n"),
      tag: `daily-digest-${date}`,
      url: "/calendar",
    });

    let deliveredAny = false;
    for (const sub of subsByUser.get(staffId) ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 * 60 * 8 },
        );
        sent += 1;
        deliveredAny = true;
      } catch (err: unknown) {
        const statusCode =
          typeof err === "object" && err !== null && "statusCode" in err
            ? Number((err as { statusCode: unknown }).statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) {
          await supabaseAdmin.from("push_subscriptions").delete().eq("id", sub.id);
          pruned += 1;
        } else {
          failed += 1;
        }
      }
    }
    logEntries.push({
      staff_id: staffId,
      digest_date: date,
      status: deliveredAny ? "sent" : "failed",
    });
  }

  if (logEntries.length > 0 && !options?.force) {
    await supabaseAdmin
      .from("daily_digest_log")
      .upsert(logEntries, { onConflict: "staff_id,digest_date" });
  }

  return { date, candidates, sent, skipped, failed, pruned };
}
