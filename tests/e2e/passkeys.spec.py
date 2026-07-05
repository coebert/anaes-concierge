"""
Playwright end-to-end tests for the passkey (WebAuthn) sign-in flow.

Scope
-----
These tests are regression guards for the CLIENT-SIDE WIRING of passkey
registration, authentication and removal — they exercise the real dev
server at http://localhost:8080 with a virtual WebAuthn authenticator, but
mock the small set of Supabase and TanStack server-function endpoints the
flows touch so tests can run offline in CI.

Covered flows:

  1. Login page — the "Sign in with passkey" button is wired to
     startPasskeyAuthentication / verifyPasskeyAuthentication and hands the
     minted magic-link token to supabase.auth.verifyOtp.
  2. Account page — the passkey manager renders, lists existing devices,
     and the "Register this device" button is wired to
     startPasskeyRegistration / verifyPasskeyRegistration.
  3. Device removal — clicking the trash icon calls deleteMyPasskey and the
     row disappears.

We do NOT re-verify @simplewebauthn's cryptography here; that library ships
its own test suite. What we protect against is the more common regression:
someone renames a server function, edits the RPC chain, or removes a UI
button, and the flow silently breaks.

Run with:
  python3 tests/e2e/passkeys.spec.py
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys

from pathlib import Path
from typing import Any

from playwright.async_api import Route, async_playwright

BASE_URL = "http://localhost:8080"
SUPABASE_HOST = "ypxhtflcnfsadcacywwx.supabase.co"

SCREENSHOTS = Path("/tmp/browser/passkeys")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Fake identity / session
# ---------------------------------------------------------------------------

FAKE_EMAIL = "passkey-e2e@example.test"
FAKE_USER = {
    "id": "00000000-0000-0000-0000-000000000042",
    "aud": "authenticated",
    "role": "authenticated",
    "email": FAKE_EMAIL,
    "app_metadata": {"provider": "email"},
    "user_metadata": {},
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z",
}
FAKE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwNDIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJlbWFpbCI6InBhc3NrZXktZTJlQGV4YW1wbGUudGVzdCIsImV4cCI6OTk5OTk5OTk5OX0."
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
    """Fulfil supabase.auth.* + REST/RPC calls with canned responses."""
    url = route.request.url
    method = route.request.method
    if "/auth/v1/user" in url and method in ("GET", "PUT"):
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(FAKE_USER))
        return
    if "/auth/v1/token" in url or "/auth/v1/verify" in url or "/auth/v1/otp" in url:
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(FAKE_SESSION))
        return
    if "/auth/v1/logout" in url:
        await route.fulfill(status=204, body="")
        return
    # /rest/v1/* (PostgREST) and /rpc/* — return an empty array so the app's
    # `(rows ?? []).map(...)` code paths don't blow up.
    if "/rest/v1/" in url or "/rpc/" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=200, content_type="application/json", body="{}")



# ---------------------------------------------------------------------------
# Server-function router
# ---------------------------------------------------------------------------
#
# TanStack Start POSTs `createServerFn` calls to `/_serverFn/<hash>` where the
# hash is content-derived. We can't hard-code it, so we dispatch by inspecting
# the request BODY for the fields each function sends. Responses use seroval's
# `toCrossJSON` envelope (`{ result, error, context }`) with the
# `x-tss-serialized` header — that's the format the real server produces and
# the client's deserializer expects. Encoding runs in a small node subprocess
# to keep parity with future seroval upgrades.


_SEROVAL_ENCODER = """\
import { toCrossJSON } from '/dev-server/node_modules/seroval/dist/esm/production/index.mjs';
const value = JSON.parse(process.argv[2]);
const refs = new Map();
process.stdout.write(JSON.stringify(
  toCrossJSON({ result: value, error: null, context: {} }, { refs }),
));
"""


def _write_encoder_once() -> Path:
    p = SCREENSHOTS / "_encoder.mjs"
    if not p.exists():
        p.write_text(_SEROVAL_ENCODER)
    return p


def seroval_encode(value: Any) -> str:
    encoder = _write_encoder_once()
    proc = subprocess.run(
        ["node", str(encoder), json.dumps(value)],
        capture_output=True, text=True, check=True,
    )
    return proc.stdout


async def fulfill_serialized(route: Route, value: Any) -> None:
    body = seroval_encode(value)
    await route.fulfill(
        status=200,
        headers={"content-type": "application/json", "x-tss-serialized": "true"},
        body=body,
    )


class PasskeyRpcRouter:
    """Dispatches TanStack `/_serverFn/*` calls by matching request bodies."""

    def __init__(self) -> None:
        self.hits: dict[str, int] = {
            "startRegistration": 0,
            "verifyRegistration": 0,
            "startAuthentication": 0,
            "verifyAuthentication": 0,
            "listPasskeys": 0,
            "deletePasskey": 0,
        }
        self.devices: list[dict[str, Any]] = []
        self._id_counter = 1

    def _bump(self, name: str) -> None:
        self.hits[name] = self.hits.get(name, 0) + 1

    async def handle(self, route: Route) -> None:
        req = route.request
        method = req.method
        raw = req.post_data or ""
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {}
        data = (payload.get("data") or {}) if isinstance(payload, dict) else {}

        # startPasskeyAuthentication: { email }
        if method == "POST" and isinstance(data, dict) and set(data.keys()) == {"email"}:
            self._bump("startAuthentication")
            await fulfill_serialized(route, {
                "options": {
                    "challenge": "ZmFrZS1jaGFsbGVuZ2U",
                    "rpId": "localhost",
                    "timeout": 60000,
                    "userVerification": "preferred",
                    "allowCredentials": [],
                },
                "hasPasskeys": len(self.devices) > 0,
            })
            return

        # verifyPasskeyAuthentication: { email, response }
        if method == "POST" and isinstance(data, dict) and "email" in data and "response" in data:
            self._bump("verifyAuthentication")
            await fulfill_serialized(route, {"tokenHash": "fake-magic-link-hash"})
            return

        # verifyPasskeyRegistration: { response, deviceName? }
        if method == "POST" and isinstance(data, dict) and "response" in data:
            self._bump("verifyRegistration")
            self._id_counter += 1
            self.devices.insert(0, {
                "id": f"11111111-1111-1111-1111-{self._id_counter:012d}",
                "device_name": data.get("deviceName") or "This device",
                "created_at": "2026-07-05T12:00:00Z",
                "last_used_at": None,
            })
            await fulfill_serialized(route, {"ok": True})
            return

        # deleteMyPasskey: { id }
        if method == "POST" and isinstance(data, dict) and set(data.keys()) == {"id"}:
            self._bump("deletePasskey")
            target = data["id"]
            self.devices = [d for d in self.devices if d["id"] != target]
            await fulfill_serialized(route, {"ok": True})
            return

        # listMyPasskeys: GET, no body.
        if method == "GET":
            self._bump("listPasskeys")
            await fulfill_serialized(route, self.devices)
            return

        # startPasskeyRegistration: POST, no data.
        if method == "POST":
            self._bump("startRegistration")
            await fulfill_serialized(route, {
                "challenge": "ZmFrZS1yZWctY2hhbGxlbmdl",
                "rp": {"id": "localhost", "name": "Salisbury Anaesthetics Rota"},
                "user": {
                    "id": "ZmFrZS11c2VyLWlk",
                    "name": FAKE_EMAIL,
                    "displayName": FAKE_EMAIL,
                },
                "pubKeyCredParams": [{"alg": -7, "type": "public-key"}],
                "timeout": 60000,
                "attestation": "none",
                "authenticatorSelection": {
                    "residentKey": "preferred",
                    "userVerification": "preferred",
                },
                "excludeCredentials": [],
            })
            return

        # Unknown call — respond empty so we don't hang the test.
        await fulfill_serialized(route, None)



# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


async def prime_supabase_session(page) -> None:
    """Seed a valid Supabase session in localStorage so /account renders."""
    # Storage key format is `sb-<project-ref>-auth-token`.
    key = f"sb-{SUPABASE_HOST.split('.')[0]}-auth-token"
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    await page.evaluate(
        "([k, v]) => window.localStorage.setItem(k, v)",
        [key, json.dumps(FAKE_SESSION)],
    )


async def install_virtual_authenticator(context, page) -> None:
    """Enable a CTAP2 virtual platform authenticator via CDP.

    Without this, `navigator.credentials.create/get` throw and the flow
    aborts before we can observe the wiring. With it, the browser accepts
    the fake challenges we hand back from the mocked server functions.
    """
    cdp = await context.new_cdp_session(page)
    await cdp.send("WebAuthn.enable", {"enableUI": False})
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
        "options": {
            "protocol": "ctap2",
            "transport": "internal",
            "hasResidentKey": True,
            "hasUserVerification": True,
            "isUserVerified": True,
            "automaticPresenceSimulation": True,
        },
    })


# ---------------------------------------------------------------------------
# Individual test cases
# ---------------------------------------------------------------------------


async def test_full_passkey_journey(context) -> None:
    """One connected journey exercising registration → login → removal.

    Doing this as a single flow keeps a single virtual authenticator (and
    the resident credential it stores) across all three phases: after
    /account registers a credential, the same authenticator can satisfy the
    /login WebAuthn assertion, and afterwards we return to /account to
    remove it. Splitting the phases into separate contexts would need a
    pre-seeded credential, which the CDP virtual authenticator does not
    accept in a portable way across Chromium versions.
    """
    router = PasskeyRpcRouter()

    page = await context.new_page()
    page.on("console", lambda m: print(f"[console.{m.type}]", m.text[:250]))
    page.on("pageerror", lambda e: print("[pageerror]", str(e)[:300]))
    await context.route(f"https://{SUPABASE_HOST}/**", mock_supabase_auth)
    await context.route("**/_serverFn/**", router.handle)


    # Auto-accept the `confirm()` in the remove flow.
    page.on("dialog", lambda d: asyncio.create_task(d.accept()))

    await install_virtual_authenticator(context, page)
    await prime_supabase_session(page)

    # -------------------- Phase 1: registration --------------------
    await page.goto(f"{BASE_URL}/account", wait_until="domcontentloaded")
    await page.get_by_text("Biometric sign-in (passkeys)").wait_for(state="visible", timeout=15_000)
    await page.get_by_text("No passkeys registered yet.").wait_for(state="visible", timeout=5_000)

    await page.get_by_role("button", name="Register this device").click()

    try:
        await page.wait_for_function(
            "() => Array.from(document.querySelectorAll('li')).some(li => /device/i.test(li.textContent || ''))",
            timeout=15_000,
        )
    except Exception:
        await page.screenshot(path=str(SCREENSHOTS / "FAIL_register.png"))
        print("HITS:", router.hits)
        print("BODY:", (await page.locator("body").inner_text())[:800])
        raise


    assert router.hits["startRegistration"] >= 1, "startPasskeyRegistration was never called"
    assert router.hits["verifyRegistration"] >= 1, "verifyPasskeyRegistration was never called"
    assert len(router.devices) == 1
    await page.screenshot(path=str(SCREENSHOTS / "1_registered.png"))

    # -------------------- Phase 2: sign out + passkey login --------------------
    # Wipe the Supabase session so /login is reachable and the user is
    # forced through the passkey flow.
    await page.evaluate(
        """() => {
            for (const k of Object.keys(window.localStorage)) {
                if (k.startsWith('sb-')) window.localStorage.removeItem(k);
            }
        }"""
    )

    await page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded")
    await page.get_by_label("Email").fill(FAKE_EMAIL)
    await page.get_by_role("button", name="Sign in with passkey").click()

    try:
        await page.wait_for_url(
            lambda url: not url.rstrip("/").endswith("/login"),
            timeout=15_000,
        )
    except Exception:
        await page.screenshot(path=str(SCREENSHOTS / "FAIL_login.png"))
        print("url:", page.url)
        print("body:", (await page.locator("body").inner_text())[:500])
        raise

    assert router.hits["startAuthentication"] >= 1, "startPasskeyAuthentication was never called"
    assert router.hits["verifyAuthentication"] >= 1, "verifyPasskeyAuthentication was never called"
    await page.screenshot(path=str(SCREENSHOTS / "2_signed_in.png"))

    # -------------------- Phase 3: removal --------------------
    await page.goto(f"{BASE_URL}/account", wait_until="domcontentloaded")
    await page.get_by_text("Biometric sign-in (passkeys)").wait_for(state="visible", timeout=15_000)

    trash = page.locator("li button").filter(has=page.locator("svg")).first
    await trash.wait_for(state="visible", timeout=10_000)
    await trash.click()

    try:
        await page.get_by_text("No passkeys registered yet.").wait_for(state="visible", timeout=10_000)
    except Exception:
        await page.screenshot(path=str(SCREENSHOTS / "FAIL_remove.png"))
        raise

    assert router.hits["deletePasskey"] >= 1, "deleteMyPasskey was never called"
    assert len(router.devices) == 0
    await page.screenshot(path=str(SCREENSHOTS / "3_removed.png"))

    print("OK — full passkey journey (register → login → remove)")
    await page.close()


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


async def run() -> int:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 1800})
            try:
                print("\n--- full passkey journey ---")
                await test_full_passkey_journey(context)
            finally:
                await context.close()
        finally:
            await browser.close()
    print("\nAll passkey e2e tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))

