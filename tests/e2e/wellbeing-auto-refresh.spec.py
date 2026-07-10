"""
E2E: exception withdrawal refreshes both /wellbeing AND /admin/wellbeing
WITHOUT a manual page refresh.

"No manual refresh" invariant
-----------------------------
The tab does exactly one full page load — the initial `page.goto()`. Every
subsequent navigation goes through TanStack Router's <Link>, which is
client-side and does not fire a `load` event. The spec counts `load` events
on the page and asserts the total stays at 1 from initial render through
the final post-withdraw assertions on both pages.

Sequence (one tab, one session):
  1. goto /wellbeing                     — first (and only) load event
  2. Snapshot personal score + drivers
  3. Click sidebar "Wellbeing & attrition" (client-side nav)
  4. Snapshot admin retention row for the primary trainee
  5. Click sidebar "My exception reports" (client-side nav)
  6. Click "Withdraw" on the deterministic hours exception
     (mock PATCH → flip fixture state; invalidateWellbeing clears both
      ["my-wellbeing", user?.id] and ["admin-wellbeing"] caches)
  7. Click sidebar "My wellbeing" — assert score + drivers refreshed
  8. Click sidebar "Wellbeing & attrition" — assert admin row refreshed
  9. Assert only one `load` event fired throughout

Screenshots land in /tmp/browser/wellbeing-auto-refresh/.

Run with:
  python3 tests/e2e/wellbeing-auto-refresh.spec.py
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
)

SHOTS = Path("/tmp/browser/wellbeing-auto-refresh")
SHOTS.mkdir(parents=True, exist_ok=True)


def _exception_rows(url: str, withdrawn: bool) -> list[dict]:
    rows = [dict(r) for r in EXCEPTION_REPORTS]
    if withdrawn:
        for r in rows:
            if r["id"] == EX_HOURS_OPEN:
                r["status"] = "withdrawn"
    m = re.search(r"trainee_id=eq\.([0-9a-f-]+)", url)
    if m:
        rows = [r for r in rows if r["trainee_id"] == m.group(1)]
    if "status=neq.withdrawn" in url:
        rows = [r for r in rows if r["status"] != "withdrawn"]
    return rows


async def wait_settled(page) -> None:
    await page.wait_for_function(
        """
        () => !document.querySelector('[data-testid=wellbeing-refetching]')
              && !document.querySelector('[data-testid=admin-wellbeing-refetching]')
        """,
        timeout=8_000,
    )


async def main() -> None:
    # Loud failure on TZ drift before any Playwright work runs.
    ensure_utc()
    state = {"withdrawn": False, "patch_seen": False}

    async def exception_route(route: Route) -> None:
        req = route.request
        if req.method == "PATCH":
            assert '"withdrawn"' in (req.post_data or "")
            state["patch_seen"] = True
            state["withdrawn"] = True
            await route.fulfill(status=204, body="")
            return
        if req.method == "GET":
            rows = _exception_rows(req.url, state["withdrawn"])
            await route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(rows),
            )
            return
        await route.continue_()

    async def profiles_route(route: Route) -> None:
        url = route.request.url
        rows = [dict(p) for p in PROFILES]
        m = re.search(r"id=eq\.([0-9a-f-]+)", url)
        if m:
            rows = [r for r in rows if r["id"] == m.group(1)]
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(rows),
        )

    async with async_playwright() as pw:
        browser, context, page = await signed_in_context(
            pw, roles=("staff", "admin")
        )
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/exception_reports*", exception_route
        )
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/profiles*", profiles_route
        )

        loads = {"n": 0}
        page.on("load", lambda _p: loads.__setitem__("n", loads["n"] + 1))
        page.on("dialog", lambda d: asyncio.create_task(d.accept()))

        try:
            # ---- 1) /wellbeing (initial load) ----
            await page.goto(
                f"{BASE_URL}/wellbeing", wait_until="domcontentloaded"
            )
            await page.wait_for_selector("text=Rolling 90-day wellbeing score")
            await wait_settled(page)
            score_before = await page.locator(
                ".text-5xl.font-semibold"
            ).first.inner_text()
            drivers_before = await page.locator(
                "text=/\\d+ trainee exception reports/"
            ).first.inner_text()
            n_before = int(re.search(r"(\d+)", drivers_before).group(1))
            await page.screenshot(path=str(SHOTS / "1_wellbeing_before.png"))
            loads_after_initial = loads["n"]
            assert loads_after_initial >= 1

            # ---- 2) Client-side nav to /admin/wellbeing ----
            # NOTE: sidebar renders one link per role-visible item, and the
            # SidebarTrigger toggles it on narrow layouts. The 1280×1800
            # viewport used by signed_in_context keeps the sidebar expanded.
            await page.get_by_role(
                "link", name="Wellbeing & attrition"
            ).first.click()
            await page.wait_for_url(re.compile(r".*/admin/wellbeing$"))
            await page.wait_for_selector("text=E2E Signed-in User")
            await wait_settled(page)
            row_before = await (
                page.locator("tr", has_text="E2E Signed-in User")
                .first.inner_text()
            )
            await page.screenshot(
                path=str(SHOTS / "2_admin_wellbeing_before.png")
            )

            # ---- 3) Client-side nav to /exceptions and Withdraw ----
            await page.get_by_role(
                "link", name="My exception reports"
            ).first.click()
            await page.wait_for_url(re.compile(r".*/exceptions$"))
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

            # ---- 4) Client-side nav back to /wellbeing ----
            await page.get_by_role(
                "link", name="My wellbeing"
            ).first.click()
            await page.wait_for_url(re.compile(r".*/wellbeing$"))
            await page.wait_for_selector("text=Rolling 90-day wellbeing score")
            # Wait for the invalidated query to refetch and re-render.
            await page.wait_for_function(
                f"""
                () => {{
                    const el = [...document.querySelectorAll('*')]
                        .find(n => /\\d+ trainee exception reports/
                            .test(n.textContent || ''));
                    if (!el) return false;
                    const m = el.textContent.match(
                        /(\\d+) trainee exception reports/);
                    return m && Number(m[1]) === {n_before - 1};
                }}
                """,
                timeout=8_000,
            )
            await wait_settled(page)
            score_after = await page.locator(
                ".text-5xl.font-semibold"
            ).first.inner_text()
            drivers_after = await page.locator(
                "text=/\\d+ trainee exception reports/"
            ).first.inner_text()
            await page.screenshot(path=str(SHOTS / "4_wellbeing_after.png"))

            # ---- 5) Client-side nav to /admin/wellbeing ----
            await page.get_by_role(
                "link", name="Wellbeing & attrition"
            ).first.click()
            await page.wait_for_url(re.compile(r".*/admin/wellbeing$"))
            await page.wait_for_selector("text=E2E Signed-in User")
            await page.wait_for_function(
                """
                (prev) => {
                    const row = [...document.querySelectorAll('tr')]
                        .find(r => (r.textContent || '')
                            .includes('E2E Signed-in User'));
                    return row && row.innerText !== prev;
                }
                """,
                arg=row_before,
                timeout=8_000,
            )
            await wait_settled(page)
            row_after = await (
                page.locator("tr", has_text="E2E Signed-in User")
                .first.inner_text()
            )
            await page.screenshot(
                path=str(SHOTS / "5_admin_wellbeing_after.png")
            )

            # ---- Assertions ----
            assert score_before != score_after, (
                f"personal score unchanged: {score_before!r} -> {score_after!r}"
            )
            assert drivers_before != drivers_after
            assert row_before != row_after

            # THE CORE INVARIANT: no full page reload occurred after the
            # initial navigation. Every subsequent transition was
            # client-side (<Link>) — a manual F5 would bump this counter.
            assert loads["n"] == loads_after_initial, (
                f"Unexpected page reload: {loads_after_initial} -> {loads['n']} "
                "(a client-side <Link> must NOT fire a load event)"
            )
            print(
                f"OK — score {score_before!r} -> {score_after!r}; "
                f"admin row updated; load events = {loads['n']} (no manual refresh)"
            )
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
