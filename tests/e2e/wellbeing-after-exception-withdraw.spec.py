"""
E2E: exception withdraw refreshes both /wellbeing and /admin/wellbeing.

Screenshots at each step under /tmp/browser/wellbeing-after-withdraw/:
  1_wellbeing_before.png       — score + drivers before withdraw
  2_admin_wellbeing_before.png — retention table before withdraw
  3_withdraw_click.png         — /exceptions after clicking Withdraw
  4_wellbeing_after.png        — same page after invalidate/refetch
  5_admin_wellbeing_after.png  — admin table after invalidate/refetch

Asserts:
  - Personal score number changes after the withdraw.
  - The "trainee exception reports" driver value drops by 1.
  - Primary user's row score on /admin/wellbeing changes after refetch.

Run with:
  python3 tests/e2e/wellbeing-after-exception-withdraw.spec.py
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.async_api import async_playwright, Route  # noqa: E402

from _lib.assert_utc import ensure_utc  # noqa: E402
from _lib.signed_in import (  # noqa: E402
    BASE_URL,
    SUPABASE_HOST,
    signed_in_context,
)
from _lib.fixtures import (  # noqa: E402
    EX_HOURS_OPEN,
    EXCEPTION_REPORTS,
    PROFILES,
    TRAINEE_PRIMARY_ID,
)

SHOTS = Path("/tmp/browser/wellbeing-after-withdraw")
SHOTS.mkdir(parents=True, exist_ok=True)


def _rows_for_wellbeing_query(url: str, withdrawn: bool) -> list[dict]:
    """Return the exception_reports rows PostgREST would send for a query.

    Both /wellbeing and /admin/wellbeing filter with `.neq("status","withdrawn")`;
    /wellbeing further filters `trainee_id=eq.<primary>`.
    """
    rows = [dict(r) for r in EXCEPTION_REPORTS]
    if withdrawn:
        for r in rows:
            if r["id"] == EX_HOURS_OPEN:
                r["status"] = "withdrawn"
    # Apply the URL filters the app sends.
    m = re.search(r"trainee_id=eq\.([0-9a-f-]+)", url)
    if m:
        rows = [r for r in rows if r["trainee_id"] == m.group(1)]
    if "status=neq.withdrawn" in url:
        rows = [r for r in rows if r["status"] != "withdrawn"]
    return rows


async def main() -> None:
    # Loud failure on TZ drift before any Playwright work runs.
    ensure_utc()
    state = {"withdrawn": False, "patch_seen": False}

    async def exception_route(route: Route) -> None:
        req = route.request
        url = req.url
        if req.method == "PATCH":
            body = req.post_data or ""
            assert '"withdrawn"' in body
            state["patch_seen"] = True
            state["withdrawn"] = True
            await route.fulfill(status=204, body="")
            return
        if req.method == "GET":
            rows = _rows_for_wellbeing_query(url, state["withdrawn"])
            await route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(rows),
            )
            return
        await route.continue_()

    async def profiles_route(route: Route) -> None:
        # Admin wellbeing filters active=true — every fixture profile is
        # active, so return all.
        url = route.request.url
        m = re.search(r"id=eq\.([0-9a-f-]+)", url)
        rows = [dict(p) for p in PROFILES]
        if m:
            rows = [r for r in rows if r["id"] == m.group(1)]
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(rows if not url.endswith("&limit=1") else rows[:1]),
        )

    async with async_playwright() as pw:
        # Sign in with BOTH roles so a single session can visit /wellbeing
        # and /admin/wellbeing without re-mocking auth.
        browser, context, page = await signed_in_context(
            pw,
            roles=("staff", "admin"),
        )
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/exception_reports*",
            exception_route,
        )
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/profiles*",
            profiles_route,
        )
        page.on("dialog", lambda d: asyncio.create_task(d.accept()))

        try:
            # -------- 1) /wellbeing BEFORE --------
            await page.goto(
                f"{BASE_URL}/wellbeing", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=Rolling 90-day wellbeing score")
            # Give the query time to settle.
            await page.wait_for_function(
                "!document.querySelector('[data-testid=wellbeing-refetching]')",
                timeout=5_000,
            )
            score_before = await page.locator(
                ".text-5xl.font-semibold"
            ).first.inner_text()
            exceptions_row_before = await page.locator(
                "text=/\\d+ trainee exception reports/"
            ).first.inner_text()
            print("wellbeing before:", repr(score_before), repr(exceptions_row_before))
            await page.screenshot(path=str(SHOTS / "1_wellbeing_before.png"))
            n_before = int(re.search(r"(\d+)", exceptions_row_before).group(1))

            # -------- 2) /admin/wellbeing BEFORE --------
            await page.goto(
                f"{BASE_URL}/admin/wellbeing", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=E2E Signed-in User")
            await page.wait_for_function(
                "!document.querySelector('[data-testid=admin-wellbeing-refetching]')",
                timeout=8_000,
            )
            primary_row = page.locator("tr", has_text="E2E Signed-in User").first
            admin_before_text = await primary_row.inner_text()
            print("admin before row:", repr(admin_before_text))
            await page.screenshot(path=str(SHOTS / "2_admin_wellbeing_before.png"))

            # -------- 3) Withdraw the exception --------
            await page.goto(
                f"{BASE_URL}/exceptions", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=My exception reports")
            await page.locator("text=Hours of work").first.click()
            await page.get_by_role("button", name="Withdraw").first.click()
            for _ in range(50):
                if state["patch_seen"]:
                    break
                await page.wait_for_timeout(100)
            assert state["patch_seen"], "withdraw PATCH never fired"
            await page.wait_for_selector("text=Withdrawn", timeout=5_000)
            await page.screenshot(path=str(SHOTS / "3_withdraw_click.png"))

            # -------- 4) /wellbeing AFTER --------
            # invalidateWellbeing(qc, "exception.withdraw") clears the
            # ["my-wellbeing"] key; navigating back triggers the refetch
            # against the updated fixture.
            await page.goto(
                f"{BASE_URL}/wellbeing", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=Rolling 90-day wellbeing score")
            await page.wait_for_function(
                "!document.querySelector('[data-testid=wellbeing-refetching]')",
                timeout=8_000,
            )
            # Wait until the exceptions-driver value has actually dropped
            # (guards against a race where we screenshot the stale cache).
            await page.wait_for_function(
                f"""
                () => {{
                    const el = [...document.querySelectorAll('*')]
                        .find(n => /\\d+ trainee exception reports/.test(n.textContent || ''));
                    if (!el) return false;
                    const m = el.textContent.match(/(\\d+) trainee exception reports/);
                    return m && Number(m[1]) === {n_before - 1};
                }}
                """,
                timeout=8_000,
            )
            score_after = await page.locator(
                ".text-5xl.font-semibold"
            ).first.inner_text()
            exceptions_row_after = await page.locator(
                "text=/\\d+ trainee exception reports/"
            ).first.inner_text()
            print("wellbeing after:", repr(score_after), repr(exceptions_row_after))
            await page.screenshot(path=str(SHOTS / "4_wellbeing_after.png"))
            n_after = int(re.search(r"(\d+)", exceptions_row_after).group(1))

            # -------- 5) /admin/wellbeing AFTER --------
            await page.goto(
                f"{BASE_URL}/admin/wellbeing", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=E2E Signed-in User")
            await page.wait_for_function(
                "!document.querySelector('[data-testid=admin-wellbeing-refetching]')",
                timeout=8_000,
            )
            primary_row = page.locator("tr", has_text="E2E Signed-in User").first
            admin_after_text = await primary_row.inner_text()
            print("admin after row:", repr(admin_after_text))
            await page.screenshot(path=str(SHOTS / "5_admin_wellbeing_after.png"))

            # -------- Assertions --------
            assert n_after == n_before - 1, (
                f"exceptions driver did not drop: before={n_before} after={n_after}"
            )
            assert score_before != score_after, (
                f"personal score did not change: before={score_before!r} "
                f"after={score_after!r}"
            )
            assert admin_before_text != admin_after_text, (
                "admin row unchanged after withdraw"
            )
            print("OK — both pages reflect the withdraw immediately")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
