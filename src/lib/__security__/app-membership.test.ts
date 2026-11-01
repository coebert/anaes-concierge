import { describe, expect, it } from "vitest";
import { getActiveMembership } from "@/lib/app-membership";

function client(
  roles: string[] | Error,
  profile: { grade: string; active: boolean } | null | Error,
) {
  const res = (v: unknown) =>
    v instanceof Error ? { data: null, error: v } : { data: v, error: null };
  return {
    from: (t: string) => ({
      select: () => ({
        eq: () =>
          t === "user_roles"
            ? Promise.resolve(res(roles instanceof Error ? roles : roles.map((role) => ({ role }))))
            : { maybeSingle: () => Promise.resolve(res(profile)) },
      }),
    }),
  };
}

describe("active app membership gate", () => {
  it("allows an active user with a role", async () => {
    const m = await getActiveMembership(client(["staff"], { grade: "trainee", active: true }), "u");
    expect([...m.roles]).toEqual(["staff"]);
  });
  it("denies a signed-in user with no role (token alone is not membership)", async () => {
    await expect(
      getActiveMembership(client([], { grade: "trainee", active: true }), "u"),
    ).rejects.toThrow(/Forbidden/);
  });
  it("denies an inactive / departed profile", async () => {
    await expect(
      getActiveMembership(client(["staff"], { grade: "trainee", active: false }), "u"),
    ).rejects.toThrow(/Forbidden/);
    await expect(getActiveMembership(client(["staff"], null), "u")).rejects.toThrow(/Forbidden/);
  });
  it("fails closed on query errors", async () => {
    await expect(
      getActiveMembership(client(new Error("x"), { grade: "t", active: true }), "u"),
    ).rejects.toThrow(/verify/);
  });
});
