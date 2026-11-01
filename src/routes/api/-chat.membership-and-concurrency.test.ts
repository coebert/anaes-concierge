/**
 * /api/chat: active-membership gate and per-user stream concurrency leases.
 * Fully synthetic: backend client, AI SDK and email are mocked; no real calls.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CONV = "00000000-0000-4000-8000-0000000000cc";
const LEASE = "00000000-0000-4000-8000-0000000000aa";

type Scenario = {
  roles: string[] | "error";
  profile: { active: boolean; left_at: string | null } | null | "error";
  acquire: "grant" | "busy" | "error" | "throw" | "garbage";
  stream: "finish" | "error" | "throw" | "hang";
};
const h = vi.hoisted(() => ({
  sc: {} as Scenario,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  toolNames: [] as string[][],
  streamCalls: 0,
  tablesRead: [] as string[],
  finish: null as null | (() => Promise<void>),
}));

function makeClient() {
  const from = (table: string) => {
    h.tablesRead.push(table);
    const q: Record<string, unknown> = {};
    let single = false;
    const result = () => {
      if (table === "user_roles") {
        if (h.sc.roles === "error") return { data: null, error: { message: "boom" } };
        return { data: h.sc.roles.map((role) => ({ role })), error: null };
      }
      if (table === "profiles") {
        if (h.sc.profile === "error") return { data: null, error: { message: "boom" } };
        return {
          data: h.sc.profile ? { grade: "consultant", email: null, ...h.sc.profile } : null,
          error: null,
        };
      }
      if (table === "ai_conversations")
        return { data: single ? { id: CONV, user_id: USER_ID, title: "Chat" } : [], error: null };
      return { data: single ? null : [], error: null };
    };
    for (const m of ["select", "eq", "neq", "in", "gte", "lte", "order", "range", "limit", "or"])
      q[m] = () => q;
    q.maybeSingle = () => {
      single = true;
      return q;
    };
    q.single = q.maybeSingle;
    q.insert = () => Promise.resolve({ data: null, error: null });
    q.update = () => q;
    q.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(ok, err);
    return q;
  };
  return {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      if (fn === "take_request_quota") return { data: true, error: null };
      if (fn === "acquire_chat_stream_lease") {
        if (h.sc.acquire === "throw") throw new Error("network");
        if (h.sc.acquire === "error") return { data: null, error: { message: "down" } };
        if (h.sc.acquire === "busy") return { data: null, error: null };
        if (h.sc.acquire === "garbage") return { data: true, error: null };
        return { data: LEASE, error: null };
      }
      if (fn === "release_chat_stream_lease") return { data: true, error: null };
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient() }));
vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({}),
}));
vi.mock("@/lib/gmail.server", () => ({ sendGmail: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: (m: unknown) => m,
    stepCountIs: () => ({}),
    tool: (d: unknown) => d,
    streamText: (opts: { tools: Record<string, unknown> }) => {
      h.streamCalls += 1;
      h.toolNames.push(Object.keys(opts.tools ?? {}));
      if (h.sc.stream === "throw") throw new Error("model init failed");
      return {
        toUIMessageStreamResponse: (o: {
          onFinish: (x: { responseMessage: { parts: unknown[] } }) => Promise<void>;
          onError: (e: unknown) => string;
        }) => {
          if (h.sc.stream === "finish") void o.onFinish({ responseMessage: { parts: [] } });
          if (h.sc.stream === "error") o.onError(new Error("mid-stream"));
          if (h.sc.stream === "hang")
            h.finish = () => o.onFinish({ responseMessage: { parts: [] } });
          return new Response("ok", { status: 200 });
        },
      };
    },
  };
});

beforeAll(() => {
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.LOVABLE_API_KEY = "test";
});
beforeEach(() => {
  h.rpcCalls = [];
  h.toolNames = [];
  h.streamCalls = 0;
  h.tablesRead = [];
  h.finish = null;
  h.sc = {
    roles: ["admin"],
    profile: { active: true, left_at: null },
    acquire: "grant",
    stream: "finish",
  };
});

async function post(signal?: AbortSignal): Promise<Response> {
  const mod = await import("./chat");
  const handler = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  return handler({
    request: new Request("http://x/api/chat", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: CONV,
        messages: [{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
      signal,
    }),
  });
}
const released = () => h.rpcCalls.filter((c) => c.fn === "release_chat_stream_lease").length;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("/api/chat active membership gate", () => {
  const denials: Array<[string, Partial<Scenario>, number]> = [
    ["inactive admin", { profile: { active: false, left_at: null } }, 403],
    ["departed admin (left_at set)", { profile: { active: true, left_at: "2026-01-01" } }, 403],
    ["roleless user", { roles: [] }, 403],
    ["missing profile", { profile: null }, 403],
    ["role query error", { roles: "error" }, 503],
    ["profile query error", { profile: "error" }, 503],
  ];
  for (const [name, patch, status] of denials) {
    it(`denies ${name} (${status}) before any tool, quota or conversation read`, async () => {
      Object.assign(h.sc, patch);
      const res = await post();
      expect(res.status).toBe(status);
      expect(h.streamCalls).toBe(0);
      expect(h.rpcCalls).toEqual([]);
      expect(h.tablesRead.every((t) => t === "user_roles" || t === "profiles")).toBe(true);
    });
  }
  it("inactive, roleless and missing-profile denials are indistinguishable", async () => {
    const bodies: string[] = [];
    for (const patch of [
      { profile: { active: false, left_at: null } },
      { roles: [] },
      { profile: null },
    ] as Array<Partial<Scenario>>) {
      Object.assign(h.sc, { roles: ["admin"], profile: { active: true, left_at: null } }, patch);
      const r = await post();
      bodies.push(`${r.status}:${await r.text()}`);
    }
    expect(new Set(bodies).size).toBe(1);
  });
  it("active admin gets admin tools", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.toolNames[0]).toContain("update_staff_profile");
  });
  it("active non-admin member is served without admin tools", async () => {
    h.sc.roles = ["staff"];
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.toolNames[0]).not.toContain("update_staff_profile");
  });
});

describe("/api/chat concurrency leases", () => {
  it("acquires with the configured cap and TTL, and releases on finish", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    await flush();
    const acq = h.rpcCalls.find((c) => c.fn === "acquire_chat_stream_lease")!;
    expect(acq.args).toEqual({ p_user_id: USER_ID, p_max: 2, p_ttl_seconds: 600 });
    expect(released()).toBe(1);
  });
  it("returns 429 when the user already has the maximum streams", async () => {
    h.sc.acquire = "busy";
    const res = await post();
    expect(res.status).toBe(429);
    expect(h.streamCalls).toBe(0);
  });
  for (const mode of ["error", "throw", "garbage"] as const) {
    it(`fails closed (503) when the lease store returns ${mode}`, async () => {
      h.sc.acquire = mode;
      const res = await post();
      expect(res.status).toBe(503);
      expect(h.streamCalls).toBe(0);
    });
  }
  it("releases on stream error", async () => {
    h.sc.stream = "error";
    await post();
    await flush();
    expect(released()).toBe(1);
  });
  it("releases when the model throws before streaming", async () => {
    h.sc.stream = "throw";
    await expect(post()).rejects.toThrow(/model init failed/);
    expect(released()).toBe(1);
  });
  it("releases on client abort, and a later finish does not release twice", async () => {
    h.sc.stream = "hang";
    const ac = new AbortController();
    const res = await post(ac.signal);
    expect(res.status).toBe(200);
    expect(released()).toBe(0);
    ac.abort();
    await flush();
    expect(released()).toBe(1);
    await h.finish!();
    expect(released()).toBe(1);
  });
});
