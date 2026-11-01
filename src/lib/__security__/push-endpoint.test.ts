import { describe, expect, it } from "vitest";
import { clampPushPayload, isAllowedPushEndpoint, isDeliverableSubscription, isValidPushKeys } from "@/lib/push-endpoint";

const P256 = "B" + "a".repeat(86); // 87 chars, base64url
const AUTH = "c".repeat(22);

describe("push endpoint allowlist", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc:APA91bH-xyz",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABh",
    "https://web.push.apple.com/QGd9tq1vXr3Z",
    "https://wns2-par02p.notify.windows.com/w/?token=AwYAAAB",
  ])("accepts real browser push service %s", (u) => {
    expect(isAllowedPushEndpoint(u)).toBe(true);
  });
  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.com/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com@169.254.169.254/x",
    "https://fcm.googleapis.com:8443/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.0.0.5/x",
    "https://localhost/x",
    "https://fcm.googleapis.com/",
    "https://fcm.googleapis.com/x y",
    "javascript:alert(1)",
    "https://fcm.googleapis.com/" + "a".repeat(1100),
  ])("rejects %s", (u) => {
    expect(isAllowedPushEndpoint(u)).toBe(false);
  });
  it("validates key lengths", () => {
    expect(isValidPushKeys(P256, AUTH)).toBe(true);
    expect(isValidPushKeys("short", AUTH)).toBe(false);
    expect(isValidPushKeys(P256, "x".repeat(200))).toBe(false);
    expect(isValidPushKeys(P256, "<script>alert(1)</script>xx")).toBe(false);
  });
  it("dispatch-time revalidation drops tampered rows", () => {
    expect(isDeliverableSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: P256, auth: AUTH })).toBe(true);
    expect(isDeliverableSubscription({ endpoint: "https://internal.local/hook", p256dh: P256, auth: AUTH })).toBe(false);
  });
  it("limits payload size", () => {
    expect(clampPushPayload(JSON.stringify({ title: "ok" }))).not.toBeNull();
    expect(clampPushPayload("x".repeat(5000))).toBeNull();
  });
});
