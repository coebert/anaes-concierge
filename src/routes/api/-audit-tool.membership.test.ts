/** /api/audit-tool must refuse disabled/roleless/non-admin callers before any
 * service-role read or model call. Synthetic mocks only. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  roles: ["admin"] as string[] | "error",
  profile: { active: true, left_at: null } as { active: boolean; left_at: string | null } | null,
  tables: [] as string[],
  streamCalls: 0,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-audit" } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
    from: (t: string) => {
      h.tables.push(t);
      const data =
        t === "user_roles"
          ? h.roles === "error"
            ? null
            : h.roles.map((role) => ({ role }))
          : t === "profiles"
            ? h.profile && { grade: null, ...h.profile }
            : [];
      const error = t === "user_roles" && h.roles === "error" ? { message: "x" } : null;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "gte", "lte", "in", "not", "is", "range"]) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve({ data, error });
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data, error }).then(ok);
      return q;
    },
  }),
}));
vi.mock("@/lib/ai-gateway.server", () => ({ createLovableAiGatewayProvider: () => () => ({}) }));
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: (m: unknown) => m,
    streamText: () => {
      h.streamCalls += 1;
      return { toUIMessageStreamResponse: () => new Response("ok", { status: 200 }) };
    },
  };
});

beforeAll(() => {
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test";
  process.env.LOVABLE_API_KEY = "test";
});
beforeEach(() => {
  h.roles = ["admin"];
  h.profile = { active: true, left_at: null };
  h.tables = [];
  h.streamCalls = 0;
});

async function post(): Promise<Response> {
  const mod = await import("./audit-tool");
  const handler = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  return handler({
    request: new Request("http://x/api/audit-tool", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    }),
  });
}

describe("/api/audit-tool membership gate", () => {
  it.each([
    ["inactive admin", () => (h.profile = { active: false, left_at: null }), 403],
    ["departed admin", () => (h.profile = { active: true, left_at: "2026-01-01" }), 403],
    ["missing profile", () => (h.profile = null), 403],
    ["roleless", () => (h.roles = []), 403],
    ["active non-admin", () => (h.roles = ["rota_coordinator"]), 403],
    ["role query error", () => (h.roles = "error"), 503],
  ] as Array<[string, () => void, number]>)("refuses %s", async (_n, setup, status) => {
    setup();
    const res = await post();
    expect(res.status).toBe(status);
    expect(h.streamCalls).toBe(0);
    expect(h.tables.every((t) => t === "user_roles" || t === "profiles")).toBe(true);
  });
  it("active admin proceeds to the model", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.streamCalls).toBe(1);
  });
});
