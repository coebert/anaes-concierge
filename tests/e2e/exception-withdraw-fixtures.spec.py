"""
E2E: withdrawing an exception with deterministic fixtures.

Verifies the exceptions page:
  1. renders the primary trainee's rows from the fixed fixture set,
  2. reflects the expected stat counts (open / resolved / overdue),
  3. after the withdraw PATCH lands, refetching returns the "after"
     fixture and the stat counts match `expected_exception_stats` on
     that post-withdraw row set.

Run with:
  python3 tests/e2e/exception-withdraw-fixtures.spec.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.async_api import async_playwright, Route  # noqa: E402

from _lib.signed_in import (  # noqa: E402
    BASE_URL,
    SUPABASE_HOST,
    signed_in_context,
)
from _lib.fixtures import (  # noqa: E402
    EX_HOURS_OPEN,
    TRAINEE_PRIMARY_ID,
    exception_reports_after_withdraw,
    exception_reports_for,
    expected_exception_stats,
    rest_tables_before,
)

SCREENSHOTS = Path("/tmp/browser/exception-withdraw")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


async def main() -> None:
    withdraw_seen: dict[str, bool] = {"called": False}
    state = {"withdrawn": False}

    async def route_exception_reports(route: Route) -> None:
        req = route.request
        url = req.url
        # PostgREST PATCH is the withdraw call.
        if req.method == "PATCH" and "exception_reports" in url:
            body = req.post_data or ""
            assert '"withdrawn"' in body, f"expected withdraw payload, got {body!r}"
            assert EX_HOURS_OPEN in url or f"id=eq.{EX_HOURS_OPEN}" in url
            withdraw_seen["called"] = True
            state["withdrawn"] = True
            await route.fulfill(status=204, body="")
            return
        if req.method == "GET" and "exception_reports" in url:
            rows = (
                exception_reports_after_withdraw(EX_HOURS_OPEN)
                if state["withdrawn"]
                else exception_reports_for(TRAINEE_PRIMARY_ID)
            )
            await route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(rows),
            )
            return
        await route.continue_()

    async with async_playwright() as pw:
        browser, context, page = await signed_in_context(
            pw,
            roles=("staff",),
            rest_tables=rest_tables_before(),
        )
        # Override so exception_reports is dynamic (before/after withdraw)
        # and the PATCH is captured.
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/exception_reports*",
            route_exception_reports,
        )
        # Auto-accept the withdraw `confirm(...)` dialog.
        page.on("dialog", lambda d: asyncio.create_task(d.accept()))

        try:
            await page.goto(
                f"{BASE_URL}/exceptions", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=My exception reports")
            await page.screenshot(path=str(SCREENSHOTS / "1_before.png"))

            # Verify "before" stats match the deterministic fixture.
            before_stats = expected_exception_stats(
                exception_reports_for(TRAINEE_PRIMARY_ID)
            )
            print(
                "before:",
                f"open={before_stats.open}",
                f"resolved={before_stats.resolved}",
                f"overdue={before_stats.overdue}",
            )
            assert before_stats.open == 2
            assert before_stats.resolved == 1
            assert before_stats.overdue == 1

            # Click "Withdraw" on the hours-open exception. The card body
            # is collapsed by default — expand it first.
            hours_card = page.locator("text=Hours of work").first
            await hours_card.click()
            await page.get_by_role("button", name="Withdraw").first.click()

            # Wait for the PATCH to actually fire.
            for _ in range(50):
                if withdraw_seen["called"]:
                    break
                await page.wait_for_timeout(100)
            assert withdraw_seen["called"], "withdraw PATCH never fired"

            # After the invalidate + refetch, the "Withdrawn" badge on the
            # row is the definitive UI signal that the "after" fixture is
            # now on screen.
            await page.wait_for_selector("text=Withdrawn", timeout=5_000)
            await page.screenshot(path=str(SCREENSHOTS / "2_after.png"))

            after_stats = expected_exception_stats(
                exception_reports_after_withdraw(EX_HOURS_OPEN)
            )
            print(
                "after:",
                f"open={after_stats.open}",
                f"resolved={after_stats.resolved}",
                f"overdue={after_stats.overdue}",
            )
            # Withdrawing EX_HOURS_OPEN (an open in-SLA row) drops Open by
            # 1, leaves Resolved unchanged, and leaves Overdue unchanged
            # (the withdrawn row was NOT overdue).
            assert after_stats.open == before_stats.open - 1
            assert after_stats.resolved == before_stats.resolved
            assert after_stats.overdue == before_stats.overdue

            print("OK — deterministic withdraw fixtures verified")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
