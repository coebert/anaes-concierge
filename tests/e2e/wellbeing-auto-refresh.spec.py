"""
E2E: withdrawing an exception refreshes /wellbeing AND /admin/wellbeing
WITHOUT a manual page refresh.

Setup mimics a real user with three tabs open:
    Tab A — /wellbeing          (staff view)
    Tab B — /admin/wellbeing    (admin retention view)
    Tab C — /exceptions         (where the withdraw happens)

Sequence:
  1. Snapshot Tab A (score + drivers) and Tab B (primary trainee row).
  2. In Tab C, click "Withdraw" on the deterministic hours exception.
     The mock swaps to the post-withdraw fixture state.
  3. Bring Tab A to the front (no reload, no goto) — React Query's
     `refetchOnWindowFocus: true` on `["my-wellbeing", user?.id]` refires
     the query against the new fixture, and the DOM updates in place.
  4. Bring Tab B to the front (no reload, no goto) — same story for
     `["admin-wellbeing"]`.

"No manual refresh" is enforced by a `page.on("load", ...)` counter on
Tabs A and B: after the initial navigation, no further load events
must fire for either tab through the end of the test.

Screenshots at each step land in /tmp/browser/wellbeing-auto-refresh/.

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


async def main() -> None:
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
        # Signed in as both staff and admin so a single browser context
        # can hold all three tabs open at once.
        browser, context, tab_a = await signed_in_context(
            pw, roles=("staff", "admin")
        )
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/exception_reports*",
            exception_route,
        )
        await context.route(
            f"**://{SUPABASE_HOST}/rest/v1/profiles*", profiles_route
        )

        # Load counters — assert no post-initial reload on Tab A / Tab B.
        loads_a = {"n": 0}
        loads_b = {"n": 0}
        tab_a.on("load", lambda _p: loads_a.__setitem__("n", loads_a["n"] + 1))

        tab_b = await context.new_page()
        tab_b.on("load", lambda _p: loads_b.__setitem__("n", loads_b["n"] + 1))

        tab_c = await context.new_page()
        tab_c.on("dialog", lambda d: asyncio.create_task(d.accept()))

        try:
            # ---- Tab A: /wellbeing (initial) ----
            await tab_a.goto(
                f"{BASE_URL}/wellbeing", wait_until="domcontentloaded"
            )
            await tab_a.wait_for_selector("text=Rolling 90-day wellbeing score")
            await tab_a.wait_for_function(
                "!document.querySelector('[data-testid=wellbeing-refetching]')",
                timeout=8_000,
            )
            score_a_before = await tab_a.locator(
                ".text-5xl.font-semibold"
            ).first.inner_text()
            drivers_a_before = await tab_a.locator(
                "text=/\\d+ trainee exception reports/"
            ).first.inner_text()
            await tab_a.screenshot(path=str(SHOTS / "1_wellbeing_before.png"))
            loads_a_baseline = loads_a["n"]

            # ---- Tab B: /admin/wellbeing (initial) ----
            await tab_b.goto(
                f"{BASE_URL}/admin/wellbeing", wait_until="domcontentloaded"
            )
            await tab_b.wait_for_selector("text=E2E Signed-in User")
            await tab_b.wait_for_function(
                "!document.querySelector('[data-testid=admin-wellbeing-refetching]')",
                timeout=8_000,
            )
            row_b_before = await (
                tab_b.locator("tr", has_text="E2E Signed-in User")
                .first.inner_text()
            )
            await tab_b.screenshot(
                path=str(SHOTS / "2_admin_wellbeing_before.png")
            )
            loads_b_baseline = loads_b["n"]

            # ---- Tab C: withdraw the hours exception ----
            await tab_c.bring_to_front()
            await tab_c.goto(
                f"{BASE_URL}/exceptions", wait_until="domcontentloaded"
            )
            await tab_c.wait_for_selector("text=My exception reports")
            await tab_c.locator("text=Hours of work").first.click()
            await tab_c.get_by_role("button", name="Withdraw").first.click()
            for _ in range(50):
                if state["patch_seen"]:
                    break
                await tab_c.wait_for_timeout(100)
            assert state["patch_seen"], "withdraw PATCH never fired"
            await tab_c.wait_for_selector("text=Withdrawn", timeout=5_000)
            await tab_c.screenshot(path=str(SHOTS / "3_withdraw_click.png"))

            # ---- Tab A: bring to front, expect in-place refresh ----
            await tab_a.bring_to_front()
            # Nudge visibility/focus explicitly (Playwright's
            # bring_to_front does not always dispatch focus on Chromium).
            await tab_a.evaluate(
                """
                () => {
                    window.dispatchEvent(new Event('focus'));
                    document.dispatchEvent(new Event('visibilitychange'));
                }
                """
            )
            # Wait for the exceptions driver value to drop by one — proof
            # the query refetched without a page reload.
            n_before = int(
                re.search(r"(\d+)", drivers_a_before).group(1)
            )
            await tab_a.wait_for_function(
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
            score_a_after = await tab_a.locator(
                ".text-5xl.font-semibold"
            ).first.inner_text()
            drivers_a_after = await tab_a.locator(
                "text=/\\d+ trainee exception reports/"
            ).first.inner_text()
            await tab_a.screenshot(path=str(SHOTS / "4_wellbeing_after.png"))

            # ---- Tab B: bring to front, expect in-place refresh ----
            await tab_b.bring_to_front()
            await tab_b.evaluate(
                """
                () => {
                    window.dispatchEvent(new Event('focus'));
                    document.dispatchEvent(new Event('visibilitychange'));
                }
                """
            )
            # Row score changes 93 → 95 in this fixture; assert by waiting
            # for the row text to differ from the "before" snapshot.
            await tab_b.wait_for_function(
                f"""
                (prev) => {{
                    const row = [...document.querySelectorAll('tr')]
                        .find(r => (r.textContent || '')
                            .includes('E2E Signed-in User'));
                    return row && row.innerText !== prev;
                }}
                """,
                arg=row_b_before,
                timeout=8_000,
            )
            row_b_after = await (
                tab_b.locator("tr", has_text="E2E Signed-in User")
                .first.inner_text()
            )
            await tab_b.screenshot(
                path=str(SHOTS / "5_admin_wellbeing_after.png")
            )

            # ---- Assertions ----
            assert score_a_before != score_a_after, (
                f"personal score unchanged: {score_a_before!r} -> {score_a_after!r}"
            )
            assert drivers_a_before != drivers_a_after
            assert row_b_before != row_b_after

            # THE CORE INVARIANT: no page reload on Tab A / Tab B between
            # the initial render and the post-withdraw assertion.
            assert loads_a["n"] == loads_a_baseline, (
                f"Tab A reloaded: {loads_a_baseline} -> {loads_a['n']}"
            )
            assert loads_b["n"] == loads_b_baseline, (
                f"Tab B reloaded: {loads_b_baseline} -> {loads_b['n']}"
            )
            print(
                f"OK — wellbeing before={score_a_before!r} after={score_a_after!r}; "
                f"admin row updated; no reloads (A={loads_a['n']}, B={loads_b['n']})"
            )
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
