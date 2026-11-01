import { afterEach, describe, expect, it } from "vitest";
import { secretsMatch, verifyWebhookRequest } from "@/lib/webhook-auth";

const req = (h: Record<string, string>) =>
  new Request("https://x/api/public/hooks/x", { method: "POST", headers: h });

describe("shared webhook auth", () => {
  afterEach(() => {
    delete process.env.TEST_HOOK_SECRET;
  });
  it("accepts the exact configured secret", () => {
    process.env.TEST_HOOK_SECRET = "s3cret-value-123";
    expect(
      verifyWebhookRequest(req({ "x-webhook-secret": "s3cret-value-123" }), "TEST_HOOK_SECRET"),
    ).toBe(true);
  });
  it("rejects wrong, same-length, longer, empty and missing secrets", () => {
    process.env.TEST_HOOK_SECRET = "s3cret-value-123";
    for (const v of ["s3cret-value-124", "s3cret-value-1234", "", "S3CRET-VALUE-123"]) {
      expect(verifyWebhookRequest(req({ "x-webhook-secret": v }), "TEST_HOOK_SECRET")).toBe(false);
    }
    expect(verifyWebhookRequest(req({}), "TEST_HOOK_SECRET")).toBe(false);
  });
  it("fails closed when the secret is not configured, even for an empty header", () => {
    expect(verifyWebhookRequest(req({ "x-webhook-secret": "" }), "TEST_HOOK_SECRET")).toBe(false);
    expect(verifyWebhookRequest(req({ "x-webhook-secret": "anything" }), "TEST_HOOK_SECRET")).toBe(
      false,
    );
    expect(secretsMatch(undefined, undefined)).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
  });
});

describe("hook routes return generic 401 without config disclosure", () => {
  it("push-dispatch and daily-digest no longer reveal 'not configured'", async () => {
    delete process.env.PUSH_WEBHOOK_SECRET;
    for (const mod of [
      "@/routes/api/public/hooks/push-dispatch",
      "@/routes/api/public/hooks/daily-digest",
    ]) {
      const { Route } = await import(/* @vite-ignore */ mod);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (Route as any).options.server.handlers.POST;
      const res: Response = await handler({ request: req({ "x-webhook-secret": "guess" }) });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Unauthorized");
    }
  });
});
