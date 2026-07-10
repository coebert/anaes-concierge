"""
Wellbeing E2E smoke test — signed-in via the reusable `_lib.signed_in`
helper, so this spec runs against the real dev server without any manual
preview sign-in.

What it verifies:
  1. `/wellbeing` renders the personal wellbeing score card while signed
     in as a plain staff user (no admin role required).
  2. `/admin/wellbeing` renders the retention table while signed in as an
     admin, and does NOT redirect away.
  3. `/admin/wellbeing` DOES redirect a non-admin user away from the
     retention view (guards against a regression that broadens the gate).

Run with:
  python3 tests/e2e/wellbeing.spec.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Allow `from _lib.signed_in import ...` when the file is executed directly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.async_api import async_playwright  # noqa: E402
from _lib.signed_in import (  # noqa: E402
    BASE_URL,
    FAKE_USER_ID,
    signed_in_context,
)

SCREENSHOTS = Path("/tmp/browser/wellbeing")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


PROFILES_FIXTURE = [
    {
        "id": FAKE_USER_ID,
        "full_name": "E2E Signed-in User",
        "email": "e2e-signed-in@example.test",
        "grade": "ST5",
        "active": True,
    }
]


async def check_personal_wellbeing() -> None:
    async with async_playwright() as pw:
        browser, _context, page = await signed_in_context(
            pw,
            roles=("staff",),
            rest_tables={"profiles": PROFILES_FIXTURE},
        )
        try:
            await page.goto(f"{BASE_URL}/wellbeing", wait_until="domcontentloaded")
            # The personal wellbeing page is guarded by _authenticated —
            # if the session isn't installed correctly we'd land on /login.
            await page.wait_for_selector(
                "text=Rolling 90-day wellbeing score", timeout=10_000
            )
            await page.screenshot(path=str(SCREENSHOTS / "1_personal.png"))
            heading = await page.locator("h1, h2").first.inner_text()
            print(f"[personal] loaded — heading: {heading!r}")
        finally:
            await browser.close()


async def check_admin_wellbeing_as_admin() -> None:
    async with async_playwright() as pw:
        browser, _context, page = await signed_in_context(
            pw,
            roles=("admin",),
            rest_tables={"profiles": PROFILES_FIXTURE},
        )
        try:
            await page.goto(
                f"{BASE_URL}/admin/wellbeing", wait_until="domcontentloaded"
            )
            await page.wait_for_selector(
                "text=Wellbeing & retention", timeout=10_000
            )
            # Sanity: didn't get bounced to `/`.
            assert "/admin/wellbeing" in page.url, (
                f"admin routed away from /admin/wellbeing: {page.url}"
            )
            await page.screenshot(path=str(SCREENSHOTS / "2_admin_ok.png"))
            print(f"[admin] loaded at {page.url}")
        finally:
            await browser.close()


async def check_admin_wellbeing_blocks_non_admin() -> None:
    async with async_playwright() as pw:
        browser, _context, page = await signed_in_context(
            pw,
            roles=("staff",),  # deliberately no admin
            rest_tables={"profiles": PROFILES_FIXTURE},
        )
        try:
            await page.goto(
                f"{BASE_URL}/admin/wellbeing", wait_until="domcontentloaded"
            )
            # AdminWellbeingPage's <Navigate to="/" /> should kick in.
            await page.wait_for_function(
                "() => !location.pathname.startsWith('/admin')",
                timeout=10_000,
            )
            await page.screenshot(path=str(SCREENSHOTS / "3_admin_blocked.png"))
            print(f"[non-admin] redirected to {page.url}")
        finally:
            await browser.close()


async def main() -> None:
    await check_personal_wellbeing()
    await check_admin_wellbeing_as_admin()
    await check_admin_wellbeing_blocks_non_admin()
    print("wellbeing.spec.py: OK")


if __name__ == "__main__":
    asyncio.run(main())
