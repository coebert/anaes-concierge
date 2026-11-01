import { describe, expect, it, vi } from "vitest";
import { consumeRegistrationChallenge, verifyAuthenticationCore, type ChallengeRow, type CredentialRow, type PasskeyDeps } from "../passkey-core";

const U1 = "00000000-0000-0000-0000-000000000001";
const U2 = "00000000-0000-0000-0000-000000000002";
const C1 = "30000000-0000-0000-0000-000000000001";
const C2 = "30000000-0000-0000-0000-000000000002";

function makeDeps(opts: { challenges?: Record<string, ChallengeRow & { purpose: string }>; creds?: CredentialRow[]; emails?: Record<string, string>; verified?: boolean; counterFails?: boolean } = {}) {
  const store = new Map(Object.entries(opts.challenges ?? {}));
  const counters: Array<[string, number]> = [];
  const deps: PasskeyDeps = {
    insertChallenge: async () => "x",
    // atomic delete-returning: second consumer gets null
    consumeChallenge: async (id, purpose) => {
      const row = store.get(id);
      if (!row || row.purpose !== purpose) return null;
      store.delete(id);
      return { challenge: row.challenge, user_id: row.user_id };
    },
    findCredential: async (id) => (opts.creds ?? []).find((c) => c.credential_id === id) ?? null,
    findProfileIdByEmail: async (e) => opts.emails?.[e] ?? null,
    updateCounter: async (id, n) => {
      if (opts.counterFails) throw new Error("db down");
      counters.push([id, n]);
    },
    verify: vi.fn(async ({ expectedChallenge }) => ({ verified: opts.verified ?? expectedChallenge.startsWith("ok"), newCounter: 7 })),
  };
  return { deps, store, counters };
}
const cred = (user: string, id = "cred-1"): CredentialRow => ({ id: `row-${id}`, user_id: user, credential_id: id, public_key: "cGs=", counter: 1, transports: null });
const base = { origin: "https://app.example", rpID: "app.example" };

describe("passkey authentication ceremony binding", () => {
  it("usernameless (discoverable) flow succeeds with a NULL-user challenge", async () => {
    const { deps, counters } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: null, purpose: "authentication" } }, creds: [cred(U1)] });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).resolves.toEqual({ userId: U1 });
    expect(counters).toEqual([["row-cred-1", 7]]);
  });
  it("email flow succeeds when challenge user, email and credential agree", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: U1, purpose: "authentication" } }, creds: [cred(U1)], emails: { "a@x.test": U1 } });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, email: "A@x.test", response: { id: "cred-1" } })).resolves.toEqual({ userId: U1 });
  });
  it("replay of a consumed ceremony fails", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: null, purpose: "authentication" } }, creds: [cred(U1)] });
    await verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).rejects.toThrow(/expired/);
  });
  it("concurrent ceremonies each use their own challenge; only one wins a shared id", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: null, purpose: "authentication" }, [C2]: { challenge: "ok-2", user_id: null, purpose: "authentication" } }, creds: [cred(U1), cred(U2, "cred-2")] });
    const [a, b] = await Promise.allSettled([
      verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } }),
      verifyAuthenticationCore(deps, { ...base, ceremonyId: C2, response: { id: "cred-2" } }),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(vi.mocked(deps.verify).mock.calls.map((c) => c[0].expectedChallenge).sort()).toEqual(["ok-1", "ok-2"]);
    const r = await Promise.allSettled([
      verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } }),
    ]);
    expect(r[0].status).toBe("rejected");
  });
  it("cross-user substitution: challenge bound to U2 cannot be used with U1's credential", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: U2, purpose: "authentication" } }, creds: [cred(U1)] });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).rejects.toThrow();
    expect(deps.verify).not.toHaveBeenCalled();
  });
  it("email that resolves to a different user is rejected", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: null, purpose: "authentication" } }, creds: [cred(U1)], emails: { "b@x.test": U2 } });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, email: "b@x.test", response: { id: "cred-1" } })).rejects.toThrow();
  });
  it("expired/unknown ceremony and malformed ids fail before any credential lookup", async () => {
    const { deps } = makeDeps({ creds: [cred(U1)] });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).rejects.toThrow(/expired/);
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: "latest", response: { id: "cred-1" } })).rejects.toThrow();
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: {} })).rejects.toThrow();
  });
  it("registration challenge cannot be used for authentication", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: U1, purpose: "registration" } }, creds: [cred(U1)] });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).rejects.toThrow(/expired/);
  });
  it("failed signature verification does not persist a counter", async () => {
    const { deps, counters } = makeDeps({ challenges: { [C1]: { challenge: "bad", user_id: null, purpose: "authentication" } }, creds: [cred(U1)] });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).rejects.toThrow();
    expect(counters).toEqual([]);
  });
  it("counter write failure fails closed (no session)", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: null, purpose: "authentication" } }, creds: [cred(U1)], counterFails: true });
    await expect(verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } })).rejects.toThrow();
  });
  it("passes the server origin and RP id to WebAuthn verification", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "ok-1", user_id: null, purpose: "authentication" } }, creds: [cred(U1)] });
    await verifyAuthenticationCore(deps, { ...base, ceremonyId: C1, response: { id: "cred-1" } });
    expect(vi.mocked(deps.verify).mock.calls[0][0]).toMatchObject({ expectedOrigin: "https://app.example", expectedRPID: "app.example" });
  });
});

describe("passkey registration challenge", () => {
  it("only the user the ceremony was issued to can consume it", async () => {
    const { deps } = makeDeps({ challenges: { [C1]: { challenge: "r", user_id: U1, purpose: "registration" } } });
    await expect(consumeRegistrationChallenge(deps, C1, U2)).rejects.toThrow();
    const again = makeDeps({ challenges: { [C1]: { challenge: "r", user_id: U1, purpose: "registration" } } });
    await expect(consumeRegistrationChallenge(again.deps, C1, U1)).resolves.toBe("r");
    await expect(consumeRegistrationChallenge(again.deps, C1, U1)).rejects.toThrow();
  });
});
