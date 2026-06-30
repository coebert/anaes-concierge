import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Admins only");
}

export const listAccessRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("access_requests_v")
      .select("id, email, full_name, message, status, created_at, decided_at, decision_notes")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { requests: data ?? [] };
  });

const DecideSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "declined"]),
  notes: z.string().trim().max(1000).optional(),
  send_invite: z.boolean().default(true),
});

export const decideAccessRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => DecideSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const { data: req, error: fetchErr } = await supabaseAdmin
      .from("access_requests_v")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (fetchErr || !req) return { error: "Request not found" };

    const { error: updErr } = await supabaseAdmin
      .from("access_requests")
      .update({
        status: data.decision,
        decided_at: new Date().toISOString(),
        decided_by: context.userId,
        decision_notes: data.notes ?? null,
      })
      .eq("id", data.id);
    if (updErr) return { error: updErr.message };

    if (data.decision === "approved" && data.send_invite) {
      const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        req.email,
        { data: { full_name: req.full_name } },
      );
      if (inviteErr) return { ok: true, inviteError: inviteErr.message };
    }

    return { ok: true };
  });

export const deleteAccessRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("access_requests").delete().eq("id", data.id);
    if (error) return { error: error.message };
    return { ok: true };
  });
