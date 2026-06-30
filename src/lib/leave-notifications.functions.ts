import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sendGmail } from "./gmail.server";

async function callerIsCoordOrAdmin(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "rota_coordinator"]);
  return !!(data && data.length);
}

async function staffName(staffId: string): Promise<{ name: string; email: string | null }> {
  const { data } = await supabaseAdmin
    .from("profiles_v")
    .select("full_name, email")
    .eq("id", staffId)
    .maybeSingle();
  return { name: data?.full_name || data?.email || "A staff member", email: data?.email ?? null };
}

async function coordinatorEmails(): Promise<string[]> {
  const { data: roles } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role")
    .in("role", ["admin", "rota_coordinator"]);
  const ids = [...new Set((roles ?? []).map((r) => r.user_id))];
  if (!ids.length) return [];
  const { data: profs } = await supabaseAdmin
    .from("profiles_v")
    .select("email")
    .in("id", ids);
  return [...new Set((profs ?? []).map((p) => p.email).filter((e): e is string => !!e))];
}

function fmtDates(start: string, end: string) {
  return start === end ? start : `${start} → ${end}`;
}

export const notifyLeaveSubmitted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      leaveId: z.string().uuid(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: req } = await supabaseAdmin
      .from("leave_requests_v")
      .select("*")
      .eq("id", data.leaveId)
      .maybeSingle();
    if (!req) return { ok: false };
    if (req.staff_id !== context.userId && !(await callerIsCoordOrAdmin(context.userId))) {
      throw new Error("Forbidden");
    }

    const { name } = await staffName(req.staff_id);
    const recipients = await coordinatorEmails();
    if (!recipients.length) return { ok: true, sent: 0 };

    const subject = `Leave request: ${name} (${req.type}) ${fmtDates(req.start_date, req.end_date)}`;
    const conflictLine = req.conflict_notes ? `\n\nConflicts: ${req.conflict_notes}` : "";
    const reasonLine = req.reason ? `\n\nReason: ${req.reason}` : "";
    const text =
      `${name} has submitted a ${req.type} leave request.\n\n` +
      `Dates: ${fmtDates(req.start_date, req.end_date)}` +
      reasonLine +
      conflictLine +
      `\n\nReview it in the SDH Rota Coordinator.`;

    let sent = 0;
    for (const to of recipients) {
      try {
        await sendGmail({ to, subject, text });
        sent++;
      } catch (e) {
        console.error("notifyLeaveSubmitted send failed", to, e);
      }
    }
    return { ok: true, sent };
  });

export const notifyLeaveDecided = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      leaveId: z.string().uuid(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!(await callerIsCoordOrAdmin(context.userId))) {
      throw new Error("Forbidden");
    }
    const { data: req } = await supabaseAdmin
      .from("leave_requests_v")
      .select("*")
      .eq("id", data.leaveId)
      .maybeSingle();
    if (!req) return { ok: false };

    const { email } = await staffName(req.staff_id);
    if (!email) return { ok: true, sent: 0 };

    const subject = `Leave ${req.status}: ${req.type} ${fmtDates(req.start_date, req.end_date)}`;
    const decisionLine = req.decision_notes ? `\n\nNotes: ${req.decision_notes}` : "";
    const text =
      `Your ${req.type} leave request for ${fmtDates(req.start_date, req.end_date)} ` +
      `has been ${req.status}.` +
      decisionLine;

    try {
      await sendGmail({ to: email, subject, text });
      return { ok: true, sent: 1 };
    } catch (e) {
      console.error("notifyLeaveDecided send failed", e);
      return { ok: false };
    }
  });
