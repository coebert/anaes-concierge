"""
Robustness cover rules + weekly import status — synthetic browser smoke.

Runs against the local dev server with mocked sign-in and mocked data only
(`_lib.signed_in`): no real account, no live database, no sync, no messages.

Checks:
  1. /robustness shows the shared cover wording (ST6/ST7/ST8 + SPA
     contingency) and the week strip shows rota Status and Import as two
     separate facts (fresh import, failed attempt with last known good).
  2. /robustness/day/<date> shows the week's status + import context and a
     link back to the forecast, and the ST8 trainee is solo-capable.
  3. When duty categories can't be read, the overview, day page and
     simulator show an error with Retry instead of numbers.
  4. The home page still renders.

Run with:  python3 tests/e2e/robustness-cover-import.spec.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.async_api import Route, async_playwright, expect  # noqa: E402
from _lib.signed_in import BASE_URL, FAKE_USER_ID, signed_in_context  # noqa: E402

SHOTS = Path("/tmp/browser/robustness-cover-import")
SHOTS.mkdir(parents=True, exist_ok=True)

TODAY = dt.datetime.now(dt.timezone.utc).date()
# First weekday on/after today (the overview only lists weekdays).
DAY = TODAY + dt.timedelta(days=(7 - TODAY.weekday()) % 7 if TODAY.weekday() >= 5 else 0)
WEEK = DAY - dt.timedelta(days=DAY.weekday())
NEXT_WEEK = WEEK + dt.timedelta(days=7)
D = DAY.isoformat()
NOW_ISO = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
EARLIER_ISO = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=30)).replace(microsecond=0).isoformat()


def prof(i: str, grade: str, level: str | None = None) -> dict:
    return {
        "id": i, "full_name": f"Synth {i[-2:]}", "email": f"{i[-2:]}@example.test",
        "grade": grade, "training_level": level, "ltft_days_off": [], "active": True,
    }


SA = "10000000-0000-0000-0000-0000000000a1"
S8 = "10000000-0000-0000-0000-0000000000b8"
TABLES = {
    "profiles": [prof(FAKE_USER_ID, "consultant"), prof(SA, "consultant"), prof(S8, "trainee", "ST8")],
    "theatres": [{"id": "th1", "name": "Synthetic Theatre", "active": True}],
    "theatre_sessions": [
        {"id": "ts1", "session_date": D, "session": "am", "specialty_id": None,
         "surgical_consultant": None, "theatre_id": "th1", "notes": None},
    ],
    "rota_assignments": [
        {"id": "a1", "staff_id": SA, "session_date": D, "session": "am", "duty_type": "theatre",
         "theatre_session_id": "ts1", "role_on_list": "solo"},
        {"id": "a2", "staff_id": S8, "session_date": D, "session": "pm", "duty_type": "spa",
         "theatre_session_id": None, "role_on_list": None},
    ],
    "duty_type_pool_rules": [
        {"duty_type": "theatre", "category": "clinical_list"},
        {"duty_type": "spa", "category": "flex"},
        {"duty_type": "admin", "category": "excluded"},
    ],
    "clwrota_week_status": [
        {"week_start": WEEK.isoformat(), "status_code": "published", "source_values": ["Published"],
         "rows_seen": 2, "planned_rows": 0, "actual_rows": 2, "observed_at": NOW_ISO, "status_since": NOW_ISO},
    ],
}


def cov_row(week: dt.date, **o) -> dict:
    r = {
        "week_start": week.isoformat(), "days_total": 7, "days_ok": 7, "days_partial_only": 0,
        "days_latest_not_ok": 0, "last_full_ok_at": EARLIER_ISO, "newest_ok_at": EARLIER_ISO,
        "latest_attempt_at": EARLIER_ISO, "latest_attempt_outcome": "ok", "tracking_since": EARLIER_ISO,
    }
    r.update(o)
    return r


async def install(context, *, fail_pool_rules: bool = False) -> None:
    async def theatres(route: Route) -> None:
        # Honour the inactive-theatre filter so the synthetic theatre stays active.
        body = [] if "active=eq.false" in route.request.url else TABLES["theatres"]
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    async def pool(route: Route) -> None:
        if fail_pool_rules:
            await route.fulfill(status=500, content_type="application/json",
                                body=json.dumps({"message": "synthetic outage", "code": "XX000"}))
        else:
            await route.fulfill(status=200, content_type="application/json",
                                body=json.dumps(TABLES["duty_type_pool_rules"]))

    async def coverage(route: Route) -> None:
        body = json.loads(route.request.post_data or "{}")
        start = dt.date.fromisoformat(body["p_from"])
        start -= dt.timedelta(days=start.weekday())
        end = dt.date.fromisoformat(body["p_to"])
        rows = []
        w = start
        while w <= end:
            if w == WEEK:
                rows.append(cov_row(w, last_full_ok_at=NOW_ISO, newest_ok_at=NOW_ISO, latest_attempt_at=NOW_ISO))
            elif w == NEXT_WEEK:
                rows.append(cov_row(w, days_latest_not_ok=7, latest_attempt_at=NOW_ISO, latest_attempt_outcome="failed"))
            w += dt.timedelta(days=7)
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(rows))

    await context.route("**/rest/v1/theatres*", theatres)
    await context.route("**/rest/v1/duty_type_pool_rules*", pool)
    await context.route("**/rest/v1/rpc/get_rota_sync_week_coverage*", coverage)


async def main() -> None:
    results: list[tuple[str, bool, str]] = []

    def ok(name: str, cond: bool, detail: str = "") -> None:
        results.append((name, cond, detail))

    async with async_playwright() as pw:
        browser, context, page = await signed_in_context(pw, roles=("admin",), rest_tables=TABLES)
        await install(context)
        try:
            await page.goto(f"{BASE_URL}/robustness", wait_until="domcontentloaded")
            strip = page.get_by_role("region", name="Rota weeks — status and import")
            await expect(strip).to_be_visible(timeout=30000)
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SHOTS / "1_overview.png"))
            header = await page.get_by_text("Forward-looking coverage headroom").first.inner_text()
            ok("overview wording names ST6/ST7/ST8 and SPA contingency",
               "ST6/ST7/ST8" in header and "never part of headroom" in header, header[:200])
            txt = await strip.inner_text()
            ok("strip shows feed Status separately", "Status" in txt and "Published" in txt)
            ok("strip shows fresh Import", "Imported" in txt)
            ok("strip shows failed attempt with last known good",
               "Last import failed" in txt and "Good as of" in txt)

            await page.goto(f"{BASE_URL}/robustness/day/{D}", wait_until="domcontentloaded")
            ctx = page.get_by_role("region", name="Rota week context")
            await expect(ctx).to_be_visible(timeout=30000)
            await expect(page.get_by_text("Free senior trainees ST6/ST7/ST8 (solo-capable)").first).to_be_visible(timeout=30000)
            await page.wait_for_timeout(800)
            await page.screenshot(path=str(SHOTS / "2_day.png"))
            ct = await ctx.inner_text()
            ok("day page shows week status and import context",
               "Published" in ct and "Imported" in ct and "Recheck in the theatre pressure forecast" in ct, ct)
        finally:
            await browser.close()

        browser, context, page = await signed_in_context(pw, roles=("admin",), rest_tables=TABLES)
        await install(context, fail_pool_rules=True)
        try:
            await page.goto(f"{BASE_URL}/robustness", wait_until="domcontentloaded")
            notice = page.get_by_text("Couldn't load the cover headroom").first
            await expect(notice).to_be_visible(timeout=30000)
            ok("overview: failed duty categories → error with Retry",
               await page.get_by_role("button", name="Retry").count() > 0)
            stat = await page.get_by_text("Days flagged").locator("..").inner_text()
            ok("overview: no numeric 'Days flagged' while failed", "—" in stat, stat)
            await page.screenshot(path=str(SHOTS / "3_overview_failed.png"))

            await page.goto(f"{BASE_URL}/robustness/day/{D}", wait_until="domcontentloaded")
            await expect(page.get_by_text("Couldn't load this day's cover").first).to_be_visible(timeout=30000)
            ok("day page: failed duty categories → error with Retry",
               await page.get_by_role("button", name="Retry").count() > 0)
            await page.screenshot(path=str(SHOTS / "4_day_failed.png"))

            await page.goto(f"{BASE_URL}/robustness/simulate", wait_until="domcontentloaded")
            await expect(page.get_by_text("Cover couldn't be calculated, so no impact is shown.")).to_be_visible(timeout=30000)
            ok("simulator: no 'no new shortfall' claim when cover failed",
               await page.get_by_text("No day tips into").count() == 0)
            await page.screenshot(path=str(SHOTS / "5_sim_failed.png"))
        finally:
            await browser.close()

        browser, context, page = await signed_in_context(pw, roles=("admin",), rest_tables=TABLES)
        await install(context)
        try:
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto(f"{BASE_URL}/", wait_until="domcontentloaded")
            await expect(page.get_by_text("Rota robustness — next 7 days").first).to_be_visible(timeout=30000)
            await page.screenshot(path=str(SHOTS / "6_home.png"))
            ok("home renders the 7-day cover tile without page errors", not errors, "; ".join(errors))
        finally:
            await browser.close()

    failed = [r for r in results if not r[1]]
    for name, passed, detail in results:
        print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail and not passed else ""))
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
