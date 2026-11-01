/**
 * Bucket specs for the durable public.take_request_quota RPC
 * ('key|window_seconds|max_hits|max_bytes'). Keys are hashed so no raw IPs or
 * emails are stored.
 */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clientKeyFromRequest(req: Request): Promise<string> {
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return (await sha256Hex(`client:${ip}`)).slice(0, 32);
}

export const ACCESS_REQUEST_LIMITS = {
  perClientPerHour: 5,
  perEmailPerHour: 1,
  perEmailPerDay: 3,
  globalPerHour: 30,
} as const;

export async function accessRequestQuotaBuckets(
  clientKey: string,
  email: string,
): Promise<string[]> {
  const e = (await sha256Hex(`email:${email.toLowerCase()}`)).slice(0, 32);
  const L = ACCESS_REQUEST_LIMITS;
  return [
    `ar:c:${clientKey}|3600|${L.perClientPerHour}|`,
    `ar:e1:${e}|3600|${L.perEmailPerHour}|`,
    `ar:ed:${e}|86400|${L.perEmailPerDay}|`,
    `ar:g|3600|${L.globalPerHour}|`,
  ];
}

export const CHAT_LIMITS = {
  maxMessages: 100,
  maxTextCharsPerMessage: 8_000,
  maxPartsPerMessage: 20,
  maxRequestBytes: 200_000,
  perUserPerHour: 60,
  perUserBytesPerHour: 4_000_000,
  globalPerHour: 1_000,
} as const;

export function chatQuotaBuckets(userId: string): string[] {
  const L = CHAT_LIMITS;
  return [
    `chat:u:${userId}|3600|${L.perUserPerHour}|${L.perUserBytesPerHour}`,
    `chat:g|3600|${L.globalPerHour}|`,
  ];
}
