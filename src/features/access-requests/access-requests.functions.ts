import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sendGmail } from "@/lib/gmail.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const inputSchema = z.object({
  email: z.string().trim().email().max(255),
  full_name: z.string().trim().min(1).max(120),
  message: z.string().trim().max(1000).optional(),
});

async function adminEmails(): Promise<string[]> {
  const { data: roles } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin");
  const ids = [...new Set((roles ?? []).map((r) => r.user_id))];
  if (!ids.length) return [];
  const { data: profs } = await supabaseAdmin
    .from("profiles")
    .select("email")
    .in("id", ids);
  return [...new Set((profs ?? []).map((p) => p.email).filter((e): e is string => !!e))];
}

export const submitAccessRequest = createServerFn({ method: "POST" })
  .inputValidator((d) => inputSchema.parse(d))
  .handler(async ({ data }) => {
    const email = data.email.toLowerCase();

    // Rate-limit: reject if same email submitted in the last hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from("access_requests")
      .select("id")
      .eq("email", email)
      .gte("created_at", oneHourAgo)
      .limit(1);
    if (recent && recent.length) {
      return { ok: true, alreadyRequested: true };
    }

    const { data: inserted, error } = await supabaseAdmin
      .from("access_requests")
      .insert({
        email,
        full_name: data.full_name,
        message: data.message ?? null,
      })
      .select("id")
      .single();
    if (error || !inserted) throw new Error("Could not submit request");

    // Notify admins (best-effort).
    try {
      const recipients = await adminEmails();
      if (recipients.length) {
        const subject = `Access request: ${data.full_name}`;
        const text =
          `${data.full_name} (${email}) has requested access to the SDH Rota Coordinator.` +
          (data.message ? `\n\nMessage:\n${data.message}` : "") +
          `\n\nReview pending requests in the admin panel.`;
        await Promise.allSettled(
          recipients.map((to) => sendGmail({ to, subject, text })),
        );
      }
    } catch (e) {
      console.error("access-request notification failed", e);
    }

    return { ok: true, alreadyRequested: false };
  });
