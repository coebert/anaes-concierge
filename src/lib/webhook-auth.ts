import { createHash, timingSafeEqual } from "crypto";

/**
 * Shared, fail-closed shared-secret check for cron/webhook hooks.
 *
 * - Missing/empty configured secret => always rejected (never "open").
 * - Both values are SHA-256 hashed first so comparison is constant-time and
 *   independent of the provided value's length.
 * - Callers return the same generic 401 for "not configured" and "wrong
 *   secret", so probes cannot learn configuration state.
 */
export function secretsMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function verifyWebhookRequest(request: Request, envName: string): boolean {
  return secretsMatch(request.headers.get("x-webhook-secret"), process.env[envName]);
}

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401 });
}
