import type { Dyn } from "@/test-utils/dyn";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const insert = vi.fn();
const sendGmail = vi.fn(async () => ({ ok: true }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b: Dyn = {
      inputValidator: (v: Dyn) => ((b.v = v), b),
      handler: (h: Dyn) => (d: Dyn) => h({ data: b.v(d.data) }),
    };
    return b;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://x", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
}));
vi.mock("@/lib/gmail.server", () => ({ sendGmail }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc,
    from: (t: string) => {
      if (t === "access_requests")
        return {
          insert: (r: unknown) => (
            insert(r),
            { select: () => ({ single: async () => ({ data: { id: "1" }, error: null }) }) }
          ),
        };
      if (t === "user_roles")
        return { select: () => ({ eq: async () => ({ data: [{ user_id: "a" }], error: null }) }) };
      return {
        select: () => ({
          in: async () => ({ data: [{ email: "admin@example.invalid" }], error: null }),
        }),
      };
    },
  },
}));

beforeEach(() => {
  rpc.mockReset();
  insert.mockReset();
  sendGmail.mockClear();
});
const input = { email: "New.Person@Example.test", full_name: "New Person", message: "hi" };

describe("public access requests", () => {
  it("within quota: stores one request and notifies admins (mocked email)", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const { submitAccessRequest } = await import("./access-requests.functions");
    await expect((submitAccessRequest as unknown as Dyn)({ data: input })).resolves.toEqual({ ok: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(sendGmail).toHaveBeenCalledTimes(1);
    const [buckets] = [rpc.mock.calls[0][1].p_buckets as string[]];
    expect(buckets).toHaveLength(4);
    expect(buckets.join()).not.toContain("203.0.113.9");
    expect(buckets.join()).not.toContain("example.test");
  });
  it("over quota: same generic response, no insert, no email", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const { submitAccessRequest } = await import("./access-requests.functions");
    await expect((submitAccessRequest as unknown as Dyn)({ data: input })).resolves.toEqual({ ok: true });
    expect(insert).not.toHaveBeenCalled();
    expect(sendGmail).not.toHaveBeenCalled();
  });
  it("quota store error fails closed (no insert, no email)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db" } });
    const { submitAccessRequest } = await import("./access-requests.functions");
    await expect((submitAccessRequest as unknown as Dyn)({ data: input })).rejects.toThrow(/try again/);
    expect(insert).not.toHaveBeenCalled();
  });
  it("rejects oversized input", async () => {
    const { submitAccessRequest } = await import("./access-requests.functions");
    expect(() =>
      (submitAccessRequest as unknown as Dyn)({ data: { ...input, message: "x".repeat(1001) } }),
    ).toThrow();
  });
});
