import { describe, expect, it, vi } from "vitest";
import { acquireChatStreamLease, type LeaseRpc } from "@/lib/chat-stream-lease";

const ID = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-000000000001";

/** In-memory model of the DB lease semantics (cap, TTL reap) for race tests. */
function memoryStore(now: () => number) {
  const leases = new Map<string, { user: string; exp: number }>();
  let n = 0;
  let chain = Promise.resolve();
  const rpc: LeaseRpc = (fn, args) => {
    const run = async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      if (fn === "acquire_chat_stream_lease") {
        for (const [k, v] of leases) if (v.exp <= now()) leases.delete(k);
        const mine = [...leases.values()].filter((l) => l.user === args.p_user_id).length;
        if (mine >= (args.p_max as number)) return { data: null, error: null };
        const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        leases.set(id, {
          user: args.p_user_id as string,
          exp: now() + (args.p_ttl_seconds as number) * 1000,
        });
        return { data: id, error: null };
      }
      return { data: leases.delete(args.p_lease_id as string), error: null };
    };
    // Serialise like the per-user advisory lock.
    const p = chain.then(run);
    chain = p.then(() => undefined);
    return p;
  };
  return { rpc, leases };
}

describe("chat stream lease client", () => {
  it("grants, then releases idempotently", async () => {
    const rpc = vi.fn<LeaseRpc>(async (fn) => ({
      data: fn.startsWith("acquire") ? ID : true,
      error: null,
    }));
    const l = await acquireChatStreamLease(rpc, U);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    await Promise.all([l.release(), l.release(), l.release()]);
    expect(rpc.mock.calls.filter((c) => c[0] === "release_chat_stream_lease")).toHaveLength(1);
  });
  it("busy when the store returns null", async () => {
    expect(await acquireChatStreamLease(async () => ({ data: null, error: null }), U)).toEqual({
      ok: false,
      reason: "busy",
    });
  });
  it.each([
    ["error", async () => ({ data: null, error: { message: "x" } })],
    ["non-uuid", async () => ({ data: true, error: null })],
    [
      "throw",
      async () => {
        throw new Error("net");
      },
    ],
  ] as Array<[string, LeaseRpc]>)("fails closed on %s", async (_n, rpc) => {
    expect(await acquireChatStreamLease(rpc, U)).toEqual({ ok: false, reason: "unavailable" });
  });
  it("a failing release never throws (TTL reclaims)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = await acquireChatStreamLease(
      async (fn) =>
        fn.startsWith("acquire")
          ? { data: ID, error: null }
          : { data: null, error: { message: "down" } },
      U,
    );
    if (!l.ok) throw new Error("expected grant");
    await expect(l.release()).resolves.toBeUndefined();
    err.mockRestore();
  });
  it("20 concurrent acquires against a cap-2 store grant exactly 2; release frees one", async () => {
    const t = 0;
    const s = memoryStore(() => t);
    const res = await Promise.all(
      Array.from({ length: 20 }, () => acquireChatStreamLease(s.rpc, U)),
    );
    const granted = res.filter((r) => r.ok);
    expect(granted).toHaveLength(2);
    await (granted[0] as { release: () => Promise<void> }).release();
    expect((await acquireChatStreamLease(s.rpc, U)).ok).toBe(true);
    expect((await acquireChatStreamLease(s.rpc, U)).ok).toBe(false);
  });
  it("crashed (never released) leases expire after the TTL", async () => {
    let t = 0;
    const s = memoryStore(() => t);
    await acquireChatStreamLease(s.rpc, U);
    await acquireChatStreamLease(s.rpc, U);
    expect((await acquireChatStreamLease(s.rpc, U)).ok).toBe(false);
    t += 599_000;
    expect((await acquireChatStreamLease(s.rpc, U)).ok).toBe(false);
    t += 2_000;
    expect((await acquireChatStreamLease(s.rpc, U)).ok).toBe(true);
  });
});
