import type { MembershipCheck } from "@/lib/app-membership";

export interface MintDeps {
  checkMembership: (userId: string) => Promise<MembershipCheck>;
  getUserEmail: (userId: string) => Promise<{ email: string | null } | { error: true }>;
  generateMagicLinkHash: (email: string) => Promise<string | null>;
}

/** Same message for every non-member refusal: a disabled account is not revealed. */
export const PASSKEY_SIGNIN_FAILED = "Passkey sign-in failed.";
export const PASSKEY_SIGNIN_UNAVAILABLE = "Passkey sign-in is temporarily unavailable.";

/**
 * After a passkey assertion is verified, mint a one-shot session token —
 * ONLY for an active approved member (fail closed on lookup errors).
 */
export async function mintPasskeySession(
  deps: MintDeps,
  userId: string,
): Promise<{ tokenHash: string }> {
  const membership = await deps.checkMembership(userId);
  if (!membership.ok) {
    throw new Error(
      membership.reason === "unavailable" ? PASSKEY_SIGNIN_UNAVAILABLE : PASSKEY_SIGNIN_FAILED,
    );
  }
  const who = await deps.getUserEmail(userId);
  if ("error" in who || !who.email) throw new Error(PASSKEY_SIGNIN_UNAVAILABLE);
  const tokenHash = await deps.generateMagicLinkHash(who.email);
  if (!tokenHash) throw new Error(PASSKEY_SIGNIN_UNAVAILABLE);
  return { tokenHash };
}
