"""
Playwright end-to-end test for the password-reset "new tab" journey.

Scenario:
  1. User requests a reset link on /reset-password (Tab A).
  2. User clicks the reset link in their mail client — the browser opens the
     link in a BRAND NEW TAB (Tab B) that shares cookies/localStorage with
     Tab A but is a separate document.
  3. Tab B must reliably land on the "Set a new password" form — not the
     "Send reset link" request form.

This exercises the module-load URL capture + preflightRecoveryFlag path in
src/routes/reset-password.tsx: when supabase-js's `detectSessionInUrl`
strips the recovery hash before the React effect reads it, the page must
still flip to update mode.

Supabase auth endpoints are intercepted and mocked so the test runs offline
against the local dev server (http://localhost:8080) with no real project.

Run with:
  python3 tests/e2e/reset-password.spec.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import Route, async_playwright

BASE_URL = "http://localhost:8080"
SUPABASE_HOST = "ypxhtflcnfsadcacywwx.supabase.co"

SCREENSHOTS = Path("/tmp/browser/reset-password")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

FAKE_USER = {
    "id": "00000000-0000-0000-0000-000000000001",
    "aud": "authenticated",
    "role": "authenticated",
    "email": "reset-e2e@example.test",
    "app_metadata": {"provider": "email"},
    "user_metadata": {},
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z",
}

# supabase-js validates access_token as a JWT (3 base64url parts) before
# calling setSession — an obviously-fake string like "abc" is rejected
# client-side without ever hitting our route interceptor. Use a
# structurally-valid unsigned JWT so setSession accepts it.
FAKE_JWT = (
    # header: {"alg":"HS256","typ":"JWT"}
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    # payload: {"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aud":"authenticated","exp":9999999999}
    "eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjk5OTk5OTk5OTl9."
    "fake-signature"
)

FAKE_SESSION = {
    "access_token": FAKE_JWT,
    "refresh_token": "fake-refresh-token",
    "expires_in": 3600,
    "expires_at": 9999999999,
    "token_type": "bearer",
    "user": FAKE_USER,
}


async def mock_supabase_auth(route: Route) -> None:
    """Fulfil supabase auth calls with canned success responses.

    Covers the endpoints touched by the recovery flow:
      * POST /auth/v1/token?grant_type=refresh_token / password / pkce
      * GET  /auth/v1/user
      * POST /auth/v1/verify (token_hash)
      * PUT  /auth/v1/user   (updateUser password)
      * POST /auth/v1/logout
    """
    url = route.request.url
    if "/auth/v1/user" in url and route.request.method in ("GET", "PUT"):
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(FAKE_USER),
        )
        return
    if "/auth/v1/token" in url or "/auth/v1/verify" in url:
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(FAKE_SESSION),
        )
        return
    if "/auth/v1/logout" in url:
        await route.fulfill(status=204, body="")
        return
    # Unknown auth endpoint — return a benign empty JSON to avoid the test
    # hanging on a network request that never lands.
    await route.fulfill(status=200, content_type="application/json", body="{}")


async def run() -> int:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        await context.route("**/auth/v1/**", mock_supabase_auth)

        # --- Tab A: user is on the reset-password page requesting a link.
        tab_a = await context.new_page()
        await tab_a.goto(f"{BASE_URL}/reset-password", wait_until="domcontentloaded")
        await tab_a.wait_for_selector("text=/send reset link/i", timeout=10_000)
        await tab_a.screenshot(path=str(SCREENSHOTS / "1_tab_a_request_form.png"))
        print("tab A shows the request form:", tab_a.url)

        # --- Tab B: user clicks the email link, which opens a NEW tab.
        # Simulate the implicit-flow recovery hash Supabase attaches when the
        # user follows a password-reset email.
        recovery_hash = (
            "#access_token=fake-access-token"
            "&refresh_token=fake-refresh-token"
            "&expires_in=3600"
            "&token_type=bearer"
            "&type=recovery"
        )
        tab_b = await context.new_page()
        tab_b.on("console", lambda msg: print(f"[tab B console] {msg.type}: {msg.text}"))
        await tab_b.goto(
            f"{BASE_URL}/reset-password{recovery_hash}",
            wait_until="domcontentloaded",
        )

        # The page must land on the "Set a new password" form. CardTitle is a
        # <div>, not a heading, so match on visible text.
        heading = tab_b.get_by_text("Set a new password", exact=True)
        try:
            await heading.wait_for(state="visible", timeout=15_000)
        except Exception:
            await tab_b.screenshot(path=str(SCREENSHOTS / "FAIL_tab_b.png"))
            print("tab B failed, current URL:", tab_b.url)
            print("tab B body text:", (await tab_b.locator("body").inner_text())[:500])
            raise

        # Both password inputs must be present.
        await tab_b.get_by_label("New password", exact=True).wait_for(
            state="visible", timeout=5_000
        )
        await tab_b.get_by_label("Confirm new password").wait_for(
            state="visible", timeout=5_000
        )

        # And the request form's submit button must be gone.
        send_link_btn = tab_b.get_by_role("button", name="Send reset link")
        assert await send_link_btn.count() == 0, (
            "Tab B still shows the 'Send reset link' button — the page fell "
            "back to request mode instead of landing on the update form."
        )

        # The recovery hash must be cleaned from the URL once verified.
        assert "access_token" not in tab_b.url, (
            f"Recovery hash was not cleaned from URL: {tab_b.url}"
        )

        await tab_b.screenshot(path=str(SCREENSHOTS / "2_tab_b_update_form.png"))
        print("tab B landed on the update form:", tab_b.url)

        # --- Reload Tab B: the update form must persist thanks to the
        # sessionStorage "reset ready" flag written on verification.
        await tab_b.reload(wait_until="domcontentloaded")
        await tab_b.get_by_role("heading", name="Set a new password").wait_for(
            state="visible", timeout=10_000
        )
        await tab_b.screenshot(path=str(SCREENSHOTS / "3_tab_b_after_reload.png"))
        print("tab B still on update form after reload:", tab_b.url)

        await browser.close()
        print("OK — reset-password new-tab journey verified.")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
