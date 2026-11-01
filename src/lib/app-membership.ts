/**
 * App membership = signed in AND has at least one row in user_roles AND the
 * caller's profile is active. A valid auth token alone is not membership.
 * Uses the caller-scoped (RLS) client; fails closed on any query error.
 */
export type MembershipClient = {
  from: (t: string) => any;
};

export async function getActiveMembership(
  supabase: MembershipClient,
  userId: string,
): Promise<{ roles: Set<string>; grade: string | null }> {
  const [rolesRes, profRes] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase.from("profiles").select("grade, active").eq("id", userId).maybeSingle(),
  ]);
  if (rolesRes.error || profRes.error) throw new Error("Could not verify your access. Please try again.");
  const roles = new Set<string>(((rolesRes.data ?? []) as Array<{ role: string }>).map((r) => r.role));
  const prof = profRes.data as { grade: string | null; active: boolean | null } | null;
  if (roles.size === 0 || !prof || prof.active !== true) {
    throw new Error("Forbidden: your account does not have access to the staff directory.");
  }
  return { roles, grade: prof.grade };
}
