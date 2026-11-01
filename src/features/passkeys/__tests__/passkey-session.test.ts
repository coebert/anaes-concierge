import { describe, expect, it, vi } from "vitest";
import {
  mintPasskeySession,
  PASSKEY_SIGNIN_FAILED,
  PASSKEY_SIGNIN_UNAVAILABLE,
  type MintDeps,
} from "@/features/passkeys/passkey-session";

function deps(m: Awaited<ReturnType<MintDeps["checkMembership"]>>) {
  return {
    checkMembership: vi.fn(async () => m),
    getUserEmail: vi.fn(async () => ({ email: "synthetic@example.invalid" })),
    generateMagicLinkHash: vi.fn(async () => "hash-1"),
  };
}

describe("passkey session mint requires active membership", () => {
  it("active member gets a token", async () => {
    const d = deps({ ok: true, roles: new Set(["staff"]), grade: null });
    await expect(mintPasskeySession(d, "u")).resolves.toEqual({ tokenHash: "hash-1" });
  });
  it("non-member (inactive/roleless/missing) gets the generic failure and no token is minted", async () => {
    const d = deps({ ok: false, reason: "not_member" });
    await expect(mintPasskeySession(d, "u")).rejects.toThrow(PASSKEY_SIGNIN_FAILED);
    expect(d.getUserEmail).not.toHaveBeenCalled();
    expect(d.generateMagicLinkHash).not.toHaveBeenCalled();
  });
  it("membership lookup error fails closed", async () => {
    const d = deps({ ok: false, reason: "unavailable" });
    await expect(mintPasskeySession(d, "u")).rejects.toThrow(PASSKEY_SIGNIN_UNAVAILABLE);
    expect(d.generateMagicLinkHash).not.toHaveBeenCalled();
  });
  it("email lookup or link failure does not leak provider messages", async () => {
    const d = deps({ ok: true, roles: new Set(["staff"]), grade: null });
    d.generateMagicLinkHash.mockResolvedValueOnce(null);
    await expect(mintPasskeySession(d, "u")).rejects.toThrow(PASSKEY_SIGNIN_UNAVAILABLE);
  });
});
