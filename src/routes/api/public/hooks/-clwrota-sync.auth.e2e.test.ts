/**
 * End-to-end test for the CLWRota sync webhook (`/api/public/hooks/clwrota-sync`).
 *
 * Verifies that requests are rejected with a clear 401 Unauthorized when
 * the `x-webhook-secret` header is:
 *   - missing entirely
 *   - present but empty
 *   - present but does not match `CLWROTA_WEBHOOK_SECRET`
 *   - present but of a different length (would trip `timingSafeEqual`)
 *
 * Also verifies the server refuses to accept requests when the
 * `CLWROTA_WEBHOOK_SECRET` env var itself is unset — even a caller who
 * sends an empty header must not be accepted.
 *
 * The auth check runs BEFORE any Supabase / CLWRota work, so we don't
 * need to mock the downstream sync modules — a 401 short-circuits.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";

const SECRET = "correct-horse-battery-staple";

async function invokePost(headers: Record<string, string>): Promise<Response> {
  const mod = await import("./clwrota-sync");
  const handler = (mod.Route as any).options.server.handlers.POST as (ctx: {
    request: Request;
  }) => Promise<Response>;
  const req = new Request("http://x/api/public/hooks/clwrota-sync?step=staff", {
    method: "POST",
    headers,
  });
  return handler({ request: req });
}

beforeAll(() => {
  process.env.CLWROTA_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  process.env.CLWROTA_WEBHOOK_SECRET = SECRET;
});

describe("/api/public/hooks/clwrota-sync — webhook auth", () => {
  it("rejects requests with NO x-webhook-secret header (401)", async () => {
    const res = await invokePost({});
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("rejects an empty x-webhook-secret header (401)", async () => {
    const res = await invokePost({ "x-webhook-secret": "" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("rejects a wrong x-webhook-secret of the SAME length (401)", async () => {
    const wrong = "x".repeat(SECRET.length);
    expect(wrong.length).toBe(SECRET.length);
    expect(wrong).not.toBe(SECRET);
    const res = await invokePost({ "x-webhook-secret": wrong });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("rejects a wrong x-webhook-secret of a DIFFERENT length (401)", async () => {
    const res = await invokePost({ "x-webhook-secret": "short" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("rejects even an empty header when the server secret is unset (401)", async () => {
    // If CLWROTA_WEBHOOK_SECRET is missing, no caller can authenticate —
    // including one that also sends an empty header. Otherwise a
    // misconfigured server would silently allow anonymous syncs.
    delete process.env.CLWROTA_WEBHOOK_SECRET;
    const resNoHeader = await invokePost({});
    expect(resNoHeader.status).toBe(401);
    expect(await resNoHeader.text()).toBe("Unauthorized");

    const resEmpty = await invokePost({ "x-webhook-secret": "" });
    expect(resEmpty.status).toBe(401);
    expect(await resEmpty.text()).toBe("Unauthorized");
  });
});
