import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { accessRequestQuotaBuckets, clientKeyFromRequest } from "@/lib/request-quota";

const inputSchema = z.object({
  email: z.string().trim().email().max(255),
  full_name: z.string().trim().min(1).max(120),
  message: z.string().trim().max(1000).optional(),
});

/** Every outcome returns the same body so callers can't probe for accounts or limits. */
const GENERIC = { ok: true as const };

async function adminEmails(supabaseAdmin: any): Promise<string[]> {
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin");
  if (error) throw error;
  const ids = [...new Set(((roles ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];
  if (!ids.length) return [];
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("email")
    .in("id", ids);
  if (pErr) throw pErr;
  return [
    ...new Set(
      ((profs ?? []) as Array<{ email: string | null }>)
        .map((p) => p.email)
        .filter((e): e is string => !!e),
    ),
  ];
}

export const submitAccessRequest = createServerFn({ method: "POST" })
  .inputValidator((d) => inputSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.toLowerCase();
    const clientKey = await clientKeyFromRequest(getRequest());

    // Durable, atomic quotas (per client, per email, global). The per-email
    // 1-per-hour bucket also makes concurrent duplicate submits idempotent.
    const { data: allowed, error: qErr } = await supabaseAdmin.rpc("take_request_quota", {
      p_buckets: await accessRequestQuotaBuckets(clientKey, email),
      p_bytes: 0,
    });
    if (qErr) throw new Error("Could not submit request. Please try again later.");
    if (allowed !== true) return GENERIC;

    const { data: inserted, error } = await supabaseAdmin
      .from("access_requests")
      .insert({ email, full_name: data.full_name, message: data.message ?? null })
      .select("id")
      .single();
    if (error || !inserted) throw new Error("Could not submit request. Please try again later.");

    try {
      const { sendGmail } = await import("@/lib/gmail.server");
      const recipients = await adminEmails(supabaseAdmin);
      if (recipients.length) {
        const subject = `Access request: ${data.full_name.replace(/[\r\n]+/g, " ")}`;
        const text =
          `${data.full_name} (${email}) has requested access to the SDH Rota Coordinator.` +
          (data.message ? `\n\nMessage:\n${data.message}` : "") +
          `\n\nReview pending requests in the admin panel.`;
        await Promise.allSettled(recipients.map((to) => sendGmail({ to, subject, text })));
      }
    } catch (e) {
      console.error(
        "access-request notification failed",
        e instanceof Error ? e.message : "unknown",
      );
    }
    return GENERIC;
  });
