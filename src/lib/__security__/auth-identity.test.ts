import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { AuthIdentityGuard } from "@/lib/auth-identity";

describe("AuthIdentityGuard", () => {
  it("clears cached data from the previous account on account switch", async () => {
    const qc = new QueryClient();
    const g = new AuthIdentityGuard(qc);
    await g.setIdentity("user-a");
    qc.setQueryData(["leave"], [{ id: "a-private" }]);
    expect(await g.setIdentity("user-b")).toBe(true);
    expect(qc.getQueryData(["leave"])).toBeUndefined();
  });
  it("clears on sign-out and cancels in-flight queries", async () => {
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");
    const g = new AuthIdentityGuard(qc);
    await g.setIdentity("user-a");
    qc.setQueryData(["profile"], { name: "A" });
    expect(await g.setIdentity(null)).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(qc.getQueryData(["profile"])).toBeUndefined();
  });
  it("keeps cache on token refresh for the same user and on first mount", async () => {
    const qc = new QueryClient();
    const g = new AuthIdentityGuard(qc);
    qc.setQueryData(["x"], 1);
    expect(await g.setIdentity("user-a")).toBe(false);
    expect(await g.setIdentity("user-a")).toBe(false);
    expect(qc.getQueryData(["x"])).toBe(1);
  });
  it("marks a stale profile load from the previous identity as not current", async () => {
    const g = new AuthIdentityGuard(new QueryClient());
    await g.setIdentity("user-a");
    const tokenA = g.beginLoad("user-a");
    await g.setIdentity("user-b");
    expect(g.isCurrent(tokenA)).toBe(false);
    expect(g.isCurrent(g.beginLoad("user-b"))).toBe(true);
  });
});
