"""
End-to-end alignment test for irregular working-pattern data.

This test drives the real Staff → Working patterns page in a headless
browser, but intercepts the Data API calls (`/rest/v1/*`) so we can feed
it a controlled fixture that exercises the tricky data shapes the user
cares about:

  - Staff A: weekend-only shifts (Sat + Sun) — must render an empty
    Mon–Fri grid without breaking column alignment.
  - Staff B: AM-only Tuesdays + AM-only Thursdays — only the top half of
    those cells should shade, and every row must still line up.
  - Staff C: PM-only Mondays + PM-only Wednesdays + weekend on-call —
    only the bottom half should shade for those weekdays; the weekend
    on-call must not leak into any Mon–Fri column.

For every rendered "Normal working pattern" card we measure the 5
weekday cell x-positions and widths on the header row and on every
data row (Working AM/PM, Private/SAG, SPA, On-call). All rows in a
card must share the same 5 column x-positions and widths within a
1px tolerance — the invariant the user relies on.

Run with:
  python3 tests/e2e/working-patterns-irregular-alignment.spec.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright, Route

BASE_URL = "http://localhost:8080"
ROUTE = "/staff/working-patterns"

SCREENSHOTS = Path("/tmp/browser/working-patterns-irregular-alignment")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ("desktop", 1280, 1800),
    ("tablet", 820, 1180),
    ("mobile", 390, 900),
]

PIXEL_TOLERANCE = 1

# --- Fixture data ------------------------------------------------------------

STAFF_A_ID = "11111111-1111-1111-1111-111111111111"
STAFF_B_ID = "22222222-2222-2222-2222-222222222222"
STAFF_C_ID = "33333333-3333-3333-3333-333333333333"

PROFILES = [
    {
        "id": STAFF_A_ID,
        "full_name": "AAA Weekend-Only Consultant",
        "grade": "consultant",
        "active": True,
        "left_at": None,
    },
    {
        "id": STAFF_B_ID,
        "full_name": "BBB AM-Only Consultant",
        "grade": "consultant",
        "active": True,
        "left_at": None,
    },
    {
        "id": STAFF_C_ID,
        "full_name": "CCC PM-Only Consultant",
        "grade": "consultant",
        "active": True,
        "left_at": None,
    },
]


def _assign(staff_id: str, date: str, half: str | None, duty: str = "theatre"):
    return {
        "staff_id": staff_id,
        "duty_type": duty,
        "theatre_session_id": None,
        "session_date": date,
        "session": half,
    }


def build_assignments() -> list[dict]:
    rows: list[dict] = []
    # Six consecutive weeks — dates chosen so weekdays land on the right day.
    # 2026-01-05 is a Monday.
    mondays = ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26",
               "2026-02-02", "2026-02-09"]

    for mon in mondays:
        y, m, d = (int(x) for x in mon.split("-"))
        # Helper to shift a Monday by n days without pulling in datetime maths
        # for readability.
        import datetime as _dt
        base = _dt.date(y, m, d)

        def plus(n: int) -> str:
            return (base + _dt.timedelta(days=n)).isoformat()

        # Staff A: Saturday AM + Sunday PM only.
        rows.append(_assign(STAFF_A_ID, plus(5), "am"))  # Sat
        rows.append(_assign(STAFF_A_ID, plus(6), "pm"))  # Sun

        # Staff B: Tuesday AM + Thursday AM only.
        rows.append(_assign(STAFF_B_ID, plus(1), "am"))  # Tue
        rows.append(_assign(STAFF_B_ID, plus(3), "am"))  # Thu

        # Staff C: Monday PM + Wednesday PM + Saturday on-call (weekend leak
        # test — must NOT show in Mon–Fri on-call row).
        rows.append(_assign(STAFF_C_ID, plus(0), "pm"))  # Mon
        rows.append(_assign(STAFF_C_ID, plus(2), "pm"))  # Wed
        rows.append(
            _assign(STAFF_C_ID, plus(5), "pm",
                    duty="general_consultant_oncall"),  # Sat
        )
    return rows


ASSIGNMENTS = build_assignments()

# --- Route handler -----------------------------------------------------------


async def handle_rest(route: Route) -> None:
    url = route.request.url
    # Anything on /rest/v1/<table>?... — reply with our fixture.
    path = url.split("/rest/v1/", 1)[-1].split("?", 1)[0]

    def json_ok(body):
        return route.fulfill(
            status=200,
            headers={
                "content-type": "application/json",
                # PostgREST returns a Content-Range for range queries; harmless
                # to always include.
                "content-range": f"0-{max(len(body) - 1, 0)}/{len(body)}",
                "access-control-allow-origin": "*",
            },
            body=json.dumps(body),
        )

    if path == "profiles":
        return await json_ok(PROFILES)
    if path == "theatres":
        return await json_ok([])
    if path == "specialties":
        return await json_ok([])
    if path == "theatre_sessions":
        return await json_ok([])
    if path == "rota_assignments":
        return await json_ok(ASSIGNMENTS)
    # Everything else — let it through.
    return await route.continue_()


# --- Session restore ---------------------------------------------------------


async def restore_session(context, page) -> None:
    storage_key = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    session_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    cookies_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
    if cookies_json:
        cookies = json.loads(cookies_json)
        for c in cookies:
            c["url"] = BASE_URL
        await context.add_cookies(cookies)
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    if storage_key and session_json:
        await page.evaluate(
            f"window.localStorage.setItem({json.dumps(storage_key)}, "
            f"{json.dumps(session_json)})"
        )


# --- Measurement -------------------------------------------------------------


async def measure_cards(page) -> list[dict]:
    return await page.evaluate(
        """
        () => {
          const blocks = [...document.querySelectorAll('div.border-t')]
            .filter(b => b.textContent && b.textContent.includes('Normal working pattern'));
          return blocks.map((block, index) => {
            // Card title is the nearest ancestor CardTitle text.
            let title = '';
            const card = block.closest('[class*="rounded-xl"]');
            if (card) {
              const t = card.querySelector('.leading-tight');
              title = (t?.textContent || '').trim();
            }
            const rows = [...block.querySelectorAll(':scope > div.flex.items-center.gap-2')];
            const rowData = rows.map(r => {
              const labelEl = r.querySelector(':scope > div.w-24');
              const cells = [...r.querySelectorAll(':scope > div.flex.gap-1 > div')];
              return {
                label: (labelEl?.textContent || '').trim(),
                xs: cells.map(c => c.getBoundingClientRect().left),
                widths: cells.map(c => c.getBoundingClientRect().width),
              };
            }).filter(r => r.xs.length === 5);
            return { index, title, rows: rowData };
          });
        }
        """
    )


def check_alignment(cards, viewport, required_titles):
    failures: list[str] = []
    seen_titles = {c["title"] for c in cards}
    for t in required_titles:
        if not any(t in st for st in seen_titles):
            failures.append(
                f"[{viewport}] expected card titled ~'{t}' not rendered"
            )

    for card in cards:
        rows = card["rows"]
        if len(rows) < 2:
            failures.append(
                f"[{viewport}] card '{card['title']}' has <2 measured rows"
            )
            continue
        ref = rows[0]
        for row in rows[1:]:
            for col in range(5):
                dx = abs(row["xs"][col] - ref["xs"][col])
                dw = abs(row["widths"][col] - ref["widths"][col])
                if dx > PIXEL_TOLERANCE or dw > PIXEL_TOLERANCE:
                    failures.append(
                        f"[{viewport}] card '{card['title']}' row "
                        f"{row['label']!r} col {col} misaligned: "
                        f"Δx={dx:.1f}px Δw={dw:.1f}px"
                    )
    return failures


# --- Main --------------------------------------------------------------------


async def main() -> int:
    if os.environ.get("LOVABLE_BROWSER_AUTH_STATUS") not in ("injected", None):
        print(
            "SKIP: LOVABLE_BROWSER_AUTH_STATUS="
            f"{os.environ.get('LOVABLE_BROWSER_AUTH_STATUS')}; "
            "no authenticated session available."
        )
        return 0

    required = [
        "AAA Weekend-Only Consultant",
        "BBB AM-Only Consultant",
        "CCC PM-Only Consultant",
    ]
    all_failures: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            for label, width, height in VIEWPORTS:
                context = await browser.new_context(
                    viewport={"width": width, "height": height}
                )
                # Intercept BEFORE any navigation to avoid a live-DB response.
                await context.route("**/rest/v1/**", handle_rest)
                page = await context.new_page()
                await restore_session(context, page)
                await page.goto(
                    f"{BASE_URL}{ROUTE}", wait_until="networkidle"
                )

                try:
                    await page.get_by_text(
                        "AAA Weekend-Only Consultant"
                    ).first.wait_for(timeout=20_000)
                except Exception as exc:
                    all_failures.append(
                        f"[{label}] fixture card never rendered: {exc}"
                    )
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-no-card.png")
                    )
                    await context.close()
                    continue

                await page.wait_for_timeout(300)
                cards = await measure_cards(page)
                # Filter to just our fixture cards so a stray real card (if
                # the intercept ever leaked) can't mask a failure.
                fixture_cards = [
                    c for c in cards
                    if any(t in c["title"] for t in required)
                ]
                failures = check_alignment(fixture_cards, label, required)
                if failures:
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-failure.png")
                    )
                    all_failures.extend(failures)
                else:
                    print(
                        f"[{label}] OK — {len(fixture_cards)} fixture cards, "
                        "columns aligned across all rows."
                    )
                await context.close()
        finally:
            await browser.close()

    if all_failures:
        print("\nFAIL — irregular-data alignment regressions:")
        for m in all_failures:
            print("  -", m)
        print(f"\nScreenshots: {SCREENSHOTS}")
        return 1
    print("\nPASS — weekday columns align for weekend + AM/PM-only fixtures.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
