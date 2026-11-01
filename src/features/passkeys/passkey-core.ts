/**
 * Server-side passkey ceremony logic with injected dependencies so the
 * security rules can be unit-tested without a real database or WebAuthn
 * authenticator.
 *
 * Each ceremony is bound to one random challenge row id ("ceremonyId"),
 * returned from start and consumed exactly once by verify via
 * consume_passkey_challenge_by_id (atomic DELETE … RETURNING).
 */

export type ChallengeRow = { challenge: string; user_id: string | null };
export type CredentialRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number | string;
  transports: string[] | null;
};

export interface PasskeyDeps {
  insertChallenge(row: { user_id: string | null; challenge: string; purpose: string }): Promise<string>;
  consumeChallenge(id: string, purpose: string): Promise<ChallengeRow | null>;
  findCredential(credentialId: string): Promise<CredentialRow | null>;
  findProfileIdByEmail(email: string): Promise<string | null>;
  updateCounter(id: string, counter: number): Promise<void>;
  verify(args: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
    credential: CredentialRow;
  }): Promise<{ verified: boolean; newCounter: number }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PasskeyError extends Error {}

/** Generic failure text so responses don't reveal which check failed. */
const GENERIC = "Passkey sign-in failed. Please try again.";

export async function verifyAuthenticationCore(
  deps: PasskeyDeps,
  input: { ceremonyId: string; email?: string; response: unknown; origin: string; rpID: string },
): Promise<{ userId: string }> {
  if (!UUID_RE.test(input.ceremonyId)) throw new PasskeyError(GENERIC);
  const credId = (input.response as { id?: unknown } | null)?.id;
  if (typeof credId !== "string" || credId.length === 0 || credId.length > 1024) {
    throw new PasskeyError(GENERIC);
  }

  // Consume first: a ceremony id is single-use even when later checks fail,
  // so a failed attempt can't be retried against the same challenge.
  const ch = await deps.consumeChallenge(input.ceremonyId, "authentication");
  if (!ch) throw new PasskeyError("Passkey challenge expired. Try again.");

  const cred = await deps.findCredential(credId);
  if (!cred) throw new PasskeyError(GENERIC);

  // Email-bound ceremony: the challenge was issued for a specific user.
  if (ch.user_id !== null && ch.user_id !== cred.user_id) throw new PasskeyError(GENERIC);
  if (input.email) {
    const expected = await deps.findProfileIdByEmail(input.email.toLowerCase());
    if (!expected || expected !== cred.user_id) throw new PasskeyError(GENERIC);
  }

  const result = await deps.verify({
    response: input.response,
    expectedChallenge: ch.challenge,
    expectedOrigin: input.origin,
    expectedRPID: input.rpID,
    credential: cred,
  });
  if (!result.verified) throw new PasskeyError(GENERIC);

  // Fail closed: if the signature counter can't be persisted we do not mint
  // a session (clone detection depends on it).
  await deps.updateCounter(cred.id, result.newCounter);
  return { userId: cred.user_id };
}

export async function consumeRegistrationChallenge(
  deps: Pick<PasskeyDeps, "consumeChallenge">,
  ceremonyId: string,
  userId: string,
): Promise<string> {
  if (!UUID_RE.test(ceremonyId)) throw new PasskeyError("Passkey challenge expired. Try again.");
  const ch = await deps.consumeChallenge(ceremonyId, "registration");
  if (!ch || ch.user_id !== userId) throw new PasskeyError("Passkey challenge expired. Try again.");
  return ch.challenge;
}
