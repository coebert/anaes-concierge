/**
 * Durable per-user concurrency leases for /api/chat streams.
 *
 * - acquire: atomic DB RPC (advisory lock per user, reaps expired leases,
 *   refuses at the cap). Store errors FAIL CLOSED (unavailable).
 * - release: idempotent; called on finish, error and client abort. A lease
 *   that is never released (worker crash) expires after the TTL.
 */
export const CHAT_STREAM_LIMITS = {
  /** Max simultaneous in-flight assistant streams per user. */
  maxConcurrentPerUser: 2,
  /** Crash-recovery TTL. Must exceed the longest expected stream. */
  leaseTtlSeconds: 600,
} as const;

export type LeaseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export type LeaseAcquire =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: "busy" | "unavailable" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function acquireChatStreamLease(
  rpc: LeaseRpc,
  userId: string,
  limits: { maxConcurrentPerUser: number; leaseTtlSeconds: number } = CHAT_STREAM_LIMITS,
): Promise<LeaseAcquire> {
  let res: { data: unknown; error: unknown };
  try {
    res = await rpc("acquire_chat_stream_lease", {
      p_user_id: userId,
      p_max: limits.maxConcurrentPerUser,
      p_ttl_seconds: limits.leaseTtlSeconds,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.error) return { ok: false, reason: "unavailable" };
  if (res.data === null) return { ok: false, reason: "busy" };
  if (typeof res.data !== "string" || !UUID.test(res.data)) {
    // Unexpected shape: never treat as granted.
    return { ok: false, reason: "unavailable" };
  }
  const leaseId = res.data;
  let released: Promise<void> | null = null;
  const release = () => {
    released ??= (async () => {
      try {
        const r = await rpc("release_chat_stream_lease", { p_lease_id: leaseId });
        if (r.error) console.error("chat lease release failed; TTL will reclaim", leaseId);
      } catch {
        console.error("chat lease release threw; TTL will reclaim", leaseId);
      }
    })();
    return released;
  };
  return { ok: true, release };
}
