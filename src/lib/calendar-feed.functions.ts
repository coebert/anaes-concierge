import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function ensureAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Only admins can use the calendar feed for now.");
}

export const getCalendarFeedToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await ensureAdmin(supabase, userId);

    const { data: row, error } = await supabase
      .from("profiles_v")
      .select("calendar_feed_token")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    let token = row?.calendar_feed_token ?? null;
    if (!token) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const { error: upErr } = await supabaseAdmin
        .from("profiles_v")
        .update({ calendar_feed_token: token })
        .eq("id", userId);
      if (upErr) throw new Error(upErr.message);
    }
    return { token };
  });

export const regenerateCalendarFeedToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await ensureAdmin(supabase, userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const { error } = await supabaseAdmin
      .from("profiles_v")
      .update({ calendar_feed_token: token })
      .eq("id", userId);
    if (error) throw new Error(error.message);
    return { token };
  });
