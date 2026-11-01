/**
 * App membership = signed in AND at least one row in user_roles AND the
 * caller's profile exists, is active, and has no left_at date.
 * A valid auth token alone is NOT membership.
 *
 * Shared by: staff-directory server functions (RLS client), /api/chat and
 * /api/audit-tool (service-role client, before any privileged tool), and
 * passkey sign-in (before a session is minted). Fails closed on any error.
 */
export type MembershipClient = {
  // Minimal structural shape of a supabase-js client; kept loose so both the
  // RLS client and the service-role client satisfy it.
  from: (t: string) => MembershipQuery;
};
type MembershipResult<T> = PromiseLike<{ data: T | null; error: unknown }>;
interface MembershipQuery {
  select: (cols: string) => {
    eq: (
      col: string,
      val: string,
    ) => MembershipResult<Array<{ role: string }>> & {
      maybeSingle: () => MembershipResult<ProfileGate>;
    };
  };
}
interface ProfileGate {
  grade: string | null;
  active: boolean | null;
  left_at: string | null;
}

export type MembershipCheck =
  | { ok: true; roles: Set<string>; grade: string | null }
  /** not_member covers roleless, missing profile, inactive and departed —
   * deliberately indistinguishable to callers' clients. */
  | { ok: false; reason: "not_member" | "unavailable" };

export async function checkActiveMembership(
  supabase: MembershipClient,
  userId: string,
): Promise<MembershipCheck> {
  try {
    const [rolesRes, profRes] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.from("profiles").select("grade, active, left_at").eq("id", userId).maybeSingle(),
    ]);
    if (rolesRes.error || profRes.error) return { ok: false, reason: "unavailable" };
    const roles = new Set<string>((rolesRes.data ?? []).map((r) => r.role));
    const prof = profRes.data;
    if (roles.size === 0 || !prof || prof.active !== true || prof.left_at) {
      return { ok: false, reason: "not_member" };
    }
    return { ok: true, roles, grade: prof.grade };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** HTTP response for a failed membership check. Same 403 body for every
 * non-member reason so a disabled account is not distinguishable. */
export function membershipDenial(check: Extract<MembershipCheck, { ok: false }>): Response {
  return check.reason === "unavailable"
    ? new Response("The assistant is temporarily unavailable. Please try again shortly.", {
        status: 503,
      })
    : new Response("Forbidden", { status: 403 });
}

/** Throwing variant for server functions. */
export async function getActiveMembership(
  supabase: MembershipClient,
  userId: string,
): Promise<{ roles: Set<string>; grade: string | null }> {
  const check = await checkActiveMembership(supabase, userId);
  if (check.ok) return { roles: check.roles, grade: check.grade };
  if (check.reason === "unavailable")
    throw new Error("Could not verify your access. Please try again.");
  throw new Error("Forbidden: your account does not have access to the staff directory.");
}
