/**
 * Validation for Web Push subscription endpoints. Mirrors the database
 * trigger `enforce_push_subscription_endpoint` so direct REST writes and the
 * dispatcher apply the same rules.
 *
 * Only HTTPS URLs on known browser push services are accepted. No userinfo,
 * explicit ports, IP literals, or other hosts.
 */
const ALLOWED_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

const MAX_ENDPOINT_LENGTH = 1024;

export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (
    typeof endpoint !== "string" ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    return false;
  }
  // Raw-string guard: authority must be exactly a host (no userinfo/port).
  const m = /^https:\/\/([^/?#]+)\/[A-Za-z0-9._~:/?=&%+,!*()$-]+$/.exec(endpoint);
  if (!m) return false;
  const authority = m[1];
  if (authority.includes("@") || authority.includes(":")) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host !== authority.toLowerCase()) return false;
  return ALLOWED_HOSTS.some((re) => re.test(host));
}

export function isValidPushKeys(p256dh: unknown, auth: unknown): boolean {
  return (
    typeof p256dh === "string" &&
    /^[A-Za-z0-9_+/-]{86,88}={0,2}$/.test(p256dh) &&
    typeof auth === "string" &&
    /^[A-Za-z0-9_+/-]{21,24}={0,2}$/.test(auth)
  );
}

export function isDeliverableSubscription(sub: {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
}): boolean {
  return isAllowedPushEndpoint(sub.endpoint) && isValidPushKeys(sub.p256dh, sub.auth);
}

/** Web Push payloads must stay well under the 4KB service limit. */
export const MAX_PUSH_PAYLOAD_BYTES = 3000;

export function clampPushPayload(payload: string): string | null {
  return new TextEncoder().encode(payload).length <= MAX_PUSH_PAYLOAD_BYTES ? payload : null;
}
