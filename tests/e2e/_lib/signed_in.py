"""
Reusable signed-in Playwright setup for E2E specs.

Any spec that needs to hit an authenticated route (e.g. `/wellbeing`,
`/admin/wellbeing`) can drop the manual sign-in step by using this module:

    from _lib.signed_in import signed_in_context, FAKE_USER

    async with async_playwright() as pw:
        browser, context, page = await signed_in_context(
            pw, roles=("admin",), rest_tables={"profiles": [...]}
        )
        await page.goto("http://localhost:8080/admin/wellbeing")
        # ...

What it does, in order:

1. Launches a headless Chromium at 1280x1800 (matches the browser-use
   viewport convention).
2. Mocks the Supabase Auth endpoints (`/auth/v1/user`, `/auth/v1/token`,
   `/auth/v1/verify`, `/auth/v1/logout`) with a canned session so
   `supabase.auth.getUser()` and the `onAuthStateChange` bootstrap in
   `auth-context.tsx` both succeed offline.
3. Mocks the PostgREST endpoints under `/rest/v1/*`:
   - `user_roles` returns rows matching the `roles` argument, so
     `hasRole("admin")` / `isCoordinatorOrAdmin()` behave correctly.
   - Any tables passed in `rest_tables` return the fixture rows verbatim.
   - Every other table returns `[]` (an empty list, not an error) so the
     app's `(rows ?? []).map(...)` code paths don't blow up on unmapped
     reads.
4. Seeds `localStorage` with the Supabase session key BEFORE the first
   navigation, so the client-side auth listener sees a signed-in session
   on mount (no flash of the sign-in page, no interstitial redirect).

The mocks are additive: a spec can call `context.route()` again after
`signed_in_context()` to override any specific endpoint (e.g. return a
specific wellbeing-relevant row set from `leave_requests`).
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Iterable, Mapping

from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    Route,
)

BASE_URL = "http://localhost:8080"

# Must match VITE_SUPABASE_URL. The auth-storage key format is
# `sb-<project_ref>-auth-token` — this is what the Supabase JS client reads
# from localStorage on mount.
SUPABASE_PROJECT_ID = "ypxhtflcnfsadcacywwx"
SUPABASE_HOST = f"{SUPABASE_PROJECT_ID}.supabase.co"
STORAGE_KEY = f"sb-{SUPABASE_PROJECT_ID}-auth-token"

FAKE_USER_ID = "00000000-0000-0000-0000-0000000000e2"
FAKE_EMAIL = "e2e-signed-in@example.test"
FAKE_USER: dict[str, Any] = {
    "id": FAKE_USER_ID,
    "aud": "authenticated",
    "role": "authenticated",
    "email": FAKE_EMAIL,
    "app_metadata": {"provider": "email"},
    "user_metadata": {"full_name": "E2E Signed-in User"},
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z",
}
# JWT is inspected by the Supabase JS client for `exp` and `sub` — the
# signature is never verified locally, so this fake token is enough for
# every browser-side check.
FAKE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwZTIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJlbWFpbCI6ImUyZS1zaWduZWQtaW5AZXhhbXBsZS50ZXN0IiwiZXhwIjo5OTk5OTk5OTk5fQ."
    "fake-signature"
)
FAKE_SESSION: dict[str, Any] = {
    "access_token": FAKE_JWT,
    "refresh_token": "fake-refresh-token",
    "expires_in": 3600,
    "expires_at": 9999999999,
    "token_type": "bearer",
    "user": FAKE_USER,
}

RestTables = Mapping[str, list[dict[str, Any]]]


def _match_table(url: str) -> str | None:
    """Extract the PostgREST table name from `/rest/v1/<table>?...`."""
    marker = "/rest/v1/"
    idx = url.find(marker)
    if idx == -1:
        return None
    tail = url[idx + len(marker) :]
    if not tail:
        return None
    return tail.split("?", 1)[0].split("/", 1)[0]


async def _fulfil_auth(route: Route) -> None:
    url = route.request.url
    method = route.request.method
    if "/auth/v1/user" in url and method in ("GET", "PUT"):
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(FAKE_USER),
        )
        return
    if any(seg in url for seg in ("/auth/v1/token", "/auth/v1/verify", "/auth/v1/otp")):
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(FAKE_SESSION),
        )
        return
    if "/auth/v1/logout" in url:
        await route.fulfill(status=204, body="")
        return
    await route.fulfill(status=200, content_type="application/json", body="{}")


def _make_rest_handler(
    roles: Iterable[str],
    tables: RestTables | None,
) -> Callable[[Route], Awaitable[None]]:
    role_rows = [{"role": r} for r in roles]
    fixtures: dict[str, list[dict[str, Any]]] = dict(tables or {})

    async def handle(route: Route) -> None:
        url = route.request.url
        if "/rpc/" in url:
            # RPCs return an empty payload by default; specs that need a
            # specific RPC result can override with `context.route(...)`.
            await route.fulfill(
                status=200, content_type="application/json", body="[]"
            )
            return
        table = _match_table(url)
        if table == "user_roles":
            await route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(role_rows),
            )
            return
        if table and table in fixtures:
            await route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(fixtures[table]),
            )
            return
        # Unmapped table — return empty list so `.map(...)` calls don't
        # NPE. If a spec cares about this table's contents it should pass
        # a fixture (or add its own route override).
        await route.fulfill(
            status=200, content_type="application/json", body="[]"
        )

    return handle


async def route_supabase(
    context: BrowserContext,
    *,
    roles: Iterable[str] = ("staff",),
    rest_tables: RestTables | None = None,
) -> None:
    """Register the Supabase auth + REST mocks on a Playwright context."""
    await context.route(f"**://{SUPABASE_HOST}/auth/v1/**", _fulfil_auth)
    await context.route(
        f"**://{SUPABASE_HOST}/rest/v1/**",
        _make_rest_handler(roles, rest_tables),
    )
    await context.route(
        f"**://{SUPABASE_HOST}/rpc/**",
        _make_rest_handler(roles, rest_tables),
    )


async def install_session(page: Page) -> None:
    """
    Seed the Supabase auth session in localStorage BEFORE the app's client
    JS runs. Navigating to `about:blank` first establishes a document so
    `page.evaluate` runs against the localhost origin after the first real
    navigation — but the storage write itself is scoped by origin, so we
    have to hit localhost once to install it there.
    """
    # Navigate to the origin so localStorage is scoped correctly, then
    # write the session and reload. Using `page.add_init_script` would
    # inject the token into every origin the page visits, which we don't
    # want.
    await page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded")
    await page.evaluate(
        f"window.localStorage.setItem({json.dumps(STORAGE_KEY)}, {json.dumps(json.dumps(FAKE_SESSION))})"
    )


async def signed_in_context(
    playwright: Playwright,
    *,
    roles: Iterable[str] = ("staff",),
    rest_tables: RestTables | None = None,
) -> tuple[Browser, BrowserContext, Page]:
    """
    One-call convenience: launch a headless browser, install the Supabase
    mocks, seed the session, and return `(browser, context, page)` ready
    for `page.goto("/some/authenticated/route")`.

    Callers close `browser` when done.
    """
    browser = await playwright.chromium.launch(headless=True)
    context = await browser.new_context(viewport={"width": 1280, "height": 1800})
    await route_supabase(context, roles=roles, rest_tables=rest_tables)
    page = await context.new_page()
    await install_session(page)
    return browser, context, page
