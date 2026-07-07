// Server-only helpers for dispatching web push notifications.
// Loaded lazily from the route handler (never at module scope in route files).
import webpush from "web-push";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type ChangeLogRow = {
  id: string;
  assignment_id: string;
  action: string;
  session_date: string;
  session: string;
  staff_id: string | null;
  session_start_ts: string;
  hours_before_session: number;
  prev_theatre_session_id: string | null;
  new_theatre_session_id: string | null;
  prev_staff_id: string | null;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type TheatreSessionRow = {
  id: string;
  session_date: string;
  session: string;
  theatre: { name: string } | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
};

function configureVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:notifications@example.com";
  if (!pub || !priv) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, pub, priv);
}

function halfLabel(session: string): string {
  const s = session.toLowerCase();
  if (s === "am") return "AM";
  if (s === "pm") return "PM";
  if (s === "eve") return "Evening";
  if (s === "night") return "Night";
  return session;
}

function formatDate(iso: string): string {
  // 2026-07-08 -> Wed 8 Jul
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

function buildTitle(row: ChangeLogRow): string {
  return `Rota change — ${formatDate(row.session_date)} ${halfLabel(row.session)}`;
}

function buildBody(
  row: ChangeLogRow,
  recipientIsPrev: boolean,
  theatreByRow: Map<string, string>,
  nameById: Map<string, string>,
): string {
  const newTheatre = row.new_theatre_session_id ? theatreByRow.get(row.new_theatre_session_id) : undefined;
  const prevTheatre = row.prev_theatre_session_id ? theatreByRow.get(row.prev_theatre_session_id) : undefined;

  if (row.action === "insert") {
    return `You've been added to ${newTheatre ?? "a list"}.`;
  }
  if (row.action === "delete") {
    return `You've been removed from ${prevTheatre ?? "a list"}.`;
  }
  // update
  if (recipientIsPrev) {
    // The person who was previously assigned and has now been replaced.
    const successor = row.staff_id ? nameById.get(row.staff_id) : undefined;
    return `You've been taken off ${prevTheatre ?? "a list"}${successor ? ` (now ${successor})` : ""}.`;
  }
  if (prevTheatre && newTheatre && prevTheatre !== newTheatre) {
    return `Moved from ${prevTheatre} to ${newTheatre}.`;
  }
  return `Details changed on ${newTheatre ?? prevTheatre ?? "your list"}.`;
}

export async function dispatchPendingPushNotifications(): Promise<{
  scanned: number;
  sent: number;
  failed: number;
  pruned: number;
}> {
  configureVapid();

  // 1. Recent change-log rows that haven't been pushed yet.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: changes, error: changesErr } = await supabaseAdmin
    .from("rota_change_log")
    .select(
      "id, assignment_id, action, session_date, session, staff_id, session_start_ts, hours_before_session, prev_theatre_session_id, new_theatre_session_id, prev_staff_id",
    )
    .gte("changed_at", cutoff)
    .order("changed_at", { ascending: true })
    .limit(500);
  if (changesErr) throw changesErr;
  const rows = (changes ?? []) as ChangeLogRow[];
  if (rows.length === 0) return { scanned: 0, sent: 0, failed: 0, pruned: 0 };

  // 2. Filter to rows without a completed log entry.
  const { data: alreadyLogged } = await supabaseAdmin
    .from("push_notification_log")
    .select("change_log_id")
    .in(
      "change_log_id",
      rows.map((r) => r.id),
    );
  const loggedSet = new Set((alreadyLogged ?? []).map((r) => r.change_log_id as string));
  const pending = rows.filter((r) => !loggedSet.has(r.id));
  if (pending.length === 0) return { scanned: rows.length, sent: 0, failed: 0, pruned: 0 };

  // 3. Resolve theatre names for pretty bodies.
  const theatreSessionIds = new Set<string>();
  for (const r of pending) {
    if (r.new_theatre_session_id) theatreSessionIds.add(r.new_theatre_session_id);
    if (r.prev_theatre_session_id) theatreSessionIds.add(r.prev_theatre_session_id);
  }
  const theatreByRow = new Map<string, string>();
  if (theatreSessionIds.size > 0) {
    const { data: ts } = await supabaseAdmin
      .from("theatre_sessions")
      .select("id, theatre:theatres(name)")
      .in("id", Array.from(theatreSessionIds));
    for (const row of (ts ?? []) as unknown as TheatreSessionRow[]) {
      if (row.theatre?.name) theatreByRow.set(row.id, row.theatre.name);
    }
  }

  // 4. Resolve successor names (for reassignment messages).
  const successorIds = new Set<string>();
  for (const r of pending) {
    if (r.action === "update" && r.staff_id) successorIds.add(r.staff_id);
  }
  const nameById = new Map<string, string>();
  if (successorIds.size > 0) {
    const { data: profs } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name")
      .in("id", Array.from(successorIds));
    for (const p of (profs ?? []) as ProfileRow[]) {
      if (p.full_name) nameById.set(p.id, p.full_name);
    }
  }

  // 5. Build recipient list: for each change, one entry per affected staff.
  type Recipient = { userId: string; row: ChangeLogRow; recipientIsPrev: boolean };
  const recipients: Recipient[] = [];
  for (const r of pending) {
    if (r.action === "insert" && r.staff_id) {
      recipients.push({ userId: r.staff_id, row: r, recipientIsPrev: false });
    } else if (r.action === "delete" && r.staff_id) {
      recipients.push({ userId: r.staff_id, row: r, recipientIsPrev: true });
    } else if (r.action === "update") {
      if (r.staff_id) recipients.push({ userId: r.staff_id, row: r, recipientIsPrev: false });
      if (r.prev_staff_id && r.prev_staff_id !== r.staff_id) {
        recipients.push({ userId: r.prev_staff_id, row: r, recipientIsPrev: true });
      }
    }
  }
  if (recipients.length === 0) return { scanned: rows.length, sent: 0, failed: 0, pruned: 0 };

  // 6. Load subscriptions for those users.
  const userIds = Array.from(new Set(recipients.map((r) => r.userId)));
  const { data: subs } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  const subsByUser = new Map<string, SubscriptionRow[]>();
  for (const s of (subs ?? []) as SubscriptionRow[]) {
    const arr = subsByUser.get(s.user_id) ?? [];
    arr.push(s);
    subsByUser.set(s.user_id, arr);
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  const logEntries: Array<{
    change_log_id: string;
    subscription_id: string | null;
    staff_id: string;
    status: string;
    error: string | null;
  }> = [];

  // 7. Fan out. If a user has no subscription, still record a "no_subscription" log
  //    entry so we don't reprocess this change log row on the next tick.
  for (const rec of recipients) {
    const userSubs = subsByUser.get(rec.userId) ?? [];
    if (userSubs.length === 0) {
      logEntries.push({
        change_log_id: rec.row.id,
        subscription_id: null,
        staff_id: rec.userId,
        status: "no_subscription",
        error: null,
      });
      continue;
    }
    const payload = JSON.stringify({
      title: buildTitle(rec.row),
      body: buildBody(rec.row, rec.recipientIsPrev, theatreByRow, nameById),
      tag: `rota-${rec.row.assignment_id}`,
      url: `/coordinator/rota?date=${rec.row.session_date}`,
    });
    for (const sub of userSubs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 * 60 * 6 },
        );
        sent += 1;
        logEntries.push({
          change_log_id: rec.row.id,
          subscription_id: sub.id,
          staff_id: rec.userId,
          status: "sent",
          error: null,
        });
      } catch (err: unknown) {
        const statusCode =
          typeof err === "object" && err !== null && "statusCode" in err
            ? Number((err as { statusCode: unknown }).statusCode)
            : 0;
        const message = err instanceof Error ? err.message : String(err);
        if (statusCode === 404 || statusCode === 410) {
          // Subscription is gone — prune and record.
          await supabaseAdmin.from("push_subscriptions").delete().eq("id", sub.id);
          pruned += 1;
          logEntries.push({
            change_log_id: rec.row.id,
            subscription_id: sub.id,
            staff_id: rec.userId,
            status: "pruned",
            error: message,
          });
        } else {
          failed += 1;
          logEntries.push({
            change_log_id: rec.row.id,
            subscription_id: sub.id,
            staff_id: rec.userId,
            status: "failed",
            error: message,
          });
        }
      }
    }
  }

  if (logEntries.length > 0) {
    await supabaseAdmin
      .from("push_notification_log")
      .upsert(logEntries, { onConflict: "change_log_id,subscription_id" });
  }

  return { scanned: rows.length, sent, failed, pruned };
}
