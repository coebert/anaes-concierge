import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Composed middleware that first validates the Supabase bearer token
 * (via `requireSupabaseAuth`) and then asserts the caller holds the
 * `admin` role. Uses the caller's RLS-scoped supabase client rather than
 * the service-role admin client, so we don't need to import a server-only
 * module at top level.
 *
 * Handlers guarded by this middleware receive the same context shape as
 * `requireSupabaseAuth` (supabase, userId, claims).
 */
export const requireAdmin = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const { data, error } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Forbidden: admin role required");
    return next({ context });
  });
