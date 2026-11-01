import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn(async () => ({ data: false, error: null }));
const sendGmail = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc,
    from: () => {
      throw new Error("should not query tables when over quota");
    },
    auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-0000-0000-000000000001" } }, error: null }) },
  }),
}));
vi.mock("@/lib/gmail.server", () => ({ sendGmail }));
vi.mock("@/lib/ai-gateway.server", () => ({ createLovableAiGatewayProvider: () => () => ({}) }));

process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
process.env.LOVABLE_API_KEY = "test";

const CONV = "00000000-0000-0000-0000-0000000000cc";
async function post(body: string) {
  const mod = await import("./chat");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = (mod.Route as any).options.server.handlers.POST;
  return h({ request: new Request("http://x/api/chat", { method: "POST", headers: { authorization: "Bearer t" }, body }) }) as Promise<Response>;
}
const msg = (text: string) => ({ id: "m", role: "user", parts: [{ type: "text", text }] });

describe("chat request limits", () => {
  it("rejects oversized bodies with 413 before parsing or AI calls", async () => {
    const res = await post(JSON.stringify({ conversationId: CONV, messages: [msg("x".repeat(250_000))] }));
    expect(res.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects a message part over the per-message text cap", async () => {
    const res = await post(JSON.stringify({ conversationId: CONV, messages: [msg("x".repeat(9_000))] }));
    expect(res.status).toBe(400);
  });
  it("rejects more than 100 messages", async () => {
    const res = await post(JSON.stringify({ conversationId: CONV, messages: Array.from({ length: 101 }, () => msg("hi")) }));
    expect(res.status).toBe(400);
  });
  it("returns 429 when the durable hourly quota is exhausted", async () => {
    const res = await post(JSON.stringify({ conversationId: CONV, messages: [msg("hello")] }));
    expect(res.status).toBe(429);
    expect(rpc).toHaveBeenCalledWith("take_request_quota", expect.objectContaining({ p_bytes: expect.any(Number) }));
    expect(sendGmail).not.toHaveBeenCalled();
  });
  it("returns 503 (fails closed) when the quota store errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } } as never);
    const res = await post(JSON.stringify({ conversationId: CONV, messages: [msg("hello")] }));
    expect(res.status).toBe(503);
  });
});
