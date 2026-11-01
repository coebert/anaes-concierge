import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkActiveMembership } from "@/lib/app-membership";

/**
 * Validates the bearer token (requireSupabaseAuth) and then requires ACTIVE
 * APPROVED MEMBERSHIP: ≥1 user_roles row and an active profile with no
 * left_at. Fails closed on query errors. Use instead of bare
 * requireSupabaseAuth for every server function that later uses the
 * service-role client or exposes staff data. Intentionally public/self-serve
 * paths (access requests, passkey sign-in start/verify) do not use it.
 */
export const requireActiveMember = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const check = await checkActiveMembership(context.supabase, context.userId);
    if (!check.ok) {
      throw new Error(
        check.reason === "unavailable"
          ? "Could not verify your access. Please try again."
          : "Forbidden",
      );
    }
    return next({ context: { ...context, roles: check.roles } });
  });

/** Active member AND admin role (from the same membership snapshot). */
export const requireAdmin = createMiddleware({ type: "function" })
  .middleware([requireActiveMember])
  .server(async ({ next, context }) => {
    if (!context.roles.has("admin")) throw new Error("Forbidden: admin role required");
    return next({ context });
  });
