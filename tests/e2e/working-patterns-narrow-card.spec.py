"""
End-to-end test: at very narrow card widths (below Tailwind's `sm`
breakpoint), the working-pattern grid must still fit inside its card
AND the label / weekday cells must still line up.

Viewport is 340px — below the `sm` breakpoint (640px) — which is the
tightest realistic case: mobile phone in a portrait split-view, or a
1-col grid on a very narrow container. At this width the shared label
switches from `w-24` (96px) to `w-20` (80px) and the 5 flex-1 cells
share whatever space remains.

Assertions per rendered fixture card:
  1. No row overflows the card's inner right edge.
  2. Header + all data rows share the same 5 column x-positions and
     widths within a 1px tolerance.
  3. Every cell has non-zero width (>= 12px) — nothing has been
     squeezed to disappear.
  4. Every row's label element renders <= 84px wide (the narrow
     `w-20` budget plus 4px tolerance), proving the narrow style
     applied instead of the sm+ `w-24`.

Run with:
  python3 tests/e2e/working-patterns-narrow-card.spec.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright, Route

BASE_URL = "http://localhost:8080"
ROUTE = "/staff/working-patterns"

SCREENSHOTS = Path("/tmp/browser/working-patterns-narrow-card")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

# Deliberately narrower than any real phone (< sm=640px) so we exercise
# the narrow-label branch AND leave very little cell width to share.
NARROW_VIEWPORT = ("narrow", 340, 900)

PIXEL_TOLERANCE = 1
MIN_CELL_WIDTH = 12
NARROW_LABEL_MAX = 84  # w-20 (80px) + rounding tolerance

# --- Fixture data ------------------------------------------------------------

STAFF_A = "aaaaaaaa-1111-1111-1111-111111111111"
STAFF_B = "bbbbbbbb-2222-2222-2222-222222222222"

PROFILES = [
    {"id": STAFF_A, "full_name": "Dr Anne Narrow", "grade": "consultant",
     "active": True, "left_at": None},
    {"id": STAFF_B, "full_name": "Dr Ben Slim", "grade": "consultant",
     "active": True, "left_at": None},
]


def _assign(sid, date, half, duty="theatre"):
    return {"staff_id": sid, "duty_type": duty, "theatre_session_id": None,
            "session_date": date, "session": half}


def build_assignments():
    rows = []
    base = dt.date(2026, 1, 5)  # Mon
    for w in range(6):
        def plus(n):
            return (base + dt.timedelta(days=7 * w + n)).isoformat()

        # Staff A: Mon AM + Wed PM (both half-day types + a full-day cell
        # via Tuesday AM+PM). Also weekly Friday on-call.
        rows.append(_assign(STAFF_A, plus(0), "am"))
        rows.append(_assign(STAFF_A, plus(1), "am"))
        rows.append(_assign(STAFF_A, plus(1), "pm"))
        rows.append(_assign(STAFF_A, plus(2), "pm"))
        rows.append(_assign(STAFF_A, plus(4), "pm",
                            "general_consultant_oncall"))
        # SPA (must exercise the "AM+PM" 5-char label — widest cell text).
        rows.append(_assign(STAFF_A, plus(3), "am", "spa"))
        rows.append(_assign(STAFF_A, plus(3), "pm", "spa"))

        # Staff B: sparser — regular Thu AM only + private Mon.
        rows.append(_assign(STAFF_B, plus(3), "am"))
        rows.append(_assign(STAFF_B, plus(0), "am", "sag_private"))
    return rows


ASSIGNMENTS = build_assignments()


async def handle_rest(route: Route) -> None:
    path = route.request.url.split("/rest/v1/", 1)[-1].split("?", 1)[0]

    def ok(body):
        return route.fulfill(
            status=200,
            headers={
                "content-type": "application/json",
                "content-range": f"0-{max(len(body) - 1, 0)}/{len(body)}",
                "access-control-allow-origin": "*",
            },
            body=json.dumps(body),
        )

    if path == "profiles":
        return await ok(PROFILES)
    if path in ("theatres", "specialties", "theatre_sessions"):
        return await ok([])
    if path == "rota_assignments":
        return await ok(ASSIGNMENTS)
    return await route.continue_()


async def restore_session(context, page) -> None:
    sk = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    sj = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    cj = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
    if cj:
        cookies = json.loads(cj)
        for c in cookies:
            c["url"] = BASE_URL
        await context.add_cookies(cookies)
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    if sk and sj:
        await page.evaluate(
            f"window.localStorage.setItem({json.dumps(sk)}, {json.dumps(sj)})"
        )


MEASURE_JS = r"""
() => {
  const cards = [...document.querySelectorAll('.bg-card')]
    .filter(c => c.querySelector('div.border-t') &&
                 c.textContent.includes('Normal working pattern'));
  return cards.map((card, index) => {
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const pr = parseFloat(cs.paddingRight) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const cardInnerRight = cr.right - pr - br;

    const titleEl = card.querySelector('.leading-tight');
    const title = (titleEl?.textContent || '').trim();

    const block = card.querySelector('div.border-t');
    const rows = [...block.querySelectorAll(':scope > div.flex.items-center.gap-2')];
    const rowData = rows.map(r => {
      const labelEl = r.querySelector(':scope > div:first-child');
      const cells = [...r.querySelectorAll(':scope > div.flex.gap-1 > div')];
      const rowRect = r.getBoundingClientRect();
      return {
        label: (labelEl?.textContent || '').trim() || '(header)',
        labelWidth: labelEl ? labelEl.getBoundingClientRect().width : 0,
        rowRight: rowRect.right,
        xs: cells.map(c => c.getBoundingClientRect().left),
        widths: cells.map(c => c.getBoundingClientRect().width),
      };
    }).filter(r => r.xs.length === 5);

    return {
      index, title,
      cardWidth: cr.width,
      cardInnerRight,
      rows: rowData,
    };
  });
}
"""


def check(cards, viewport):
    failures = []
    if not cards:
        failures.append(f"[{viewport}] no fixture cards rendered")
        return failures

    for card in cards:
        rows = card["rows"]
        if len(rows) < 2:
            failures.append(
                f"[{viewport}] card '{card['title']}' has <2 measured rows"
            )
            continue

        # (4) Narrow label budget.
        for row in rows:
            if row["labelWidth"] > NARROW_LABEL_MAX:
                failures.append(
                    f"[{viewport}] card '{card['title']}' row "
                    f"{row['label']!r} label width "
                    f"{row['labelWidth']:.1f}px > narrow budget "
                    f"{NARROW_LABEL_MAX}px (sm: class did not un-apply)"
                )

        ref = rows[0]
        for row in rows[1:]:
            for col in range(5):
                dx = abs(row["xs"][col] - ref["xs"][col])
                dw = abs(row["widths"][col] - ref["widths"][col])
                if dx > PIXEL_TOLERANCE or dw > PIXEL_TOLERANCE:
                    failures.append(
                        f"[{viewport}] card '{card['title']}' row "
                        f"{row['label']!r} col {col} misaligned: "
                        f"Δx={dx:.1f} Δw={dw:.1f}"
                    )

        for row in rows:
            over = row["rowRight"] - card["cardInnerRight"]
            if over > PIXEL_TOLERANCE:
                failures.append(
                    f"[{viewport}] card '{card['title']}' row "
                    f"{row['label']!r} overflows card by {over:.1f}px"
                )
            for col, w in enumerate(row["widths"]):
                if w < MIN_CELL_WIDTH:
                    failures.append(
                        f"[{viewport}] card '{card['title']}' row "
                        f"{row['label']!r} col {col} shrank to {w:.1f}px "
                        f"(< {MIN_CELL_WIDTH}px minimum)"
                    )
    return failures


async def main() -> int:
    if os.environ.get("LOVABLE_BROWSER_AUTH_STATUS") not in ("injected", None):
        print(
            "SKIP: LOVABLE_BROWSER_AUTH_STATUS="
            f"{os.environ.get('LOVABLE_BROWSER_AUTH_STATUS')}; "
            "no authenticated session available."
        )
        return 0

    all_failures = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            label, w, h = NARROW_VIEWPORT
            context = await browser.new_context(
                viewport={"width": w, "height": h}
            )
            await context.route("**/rest/v1/**", handle_rest)
            page = await context.new_page()
            await restore_session(context, page)
            await page.goto(
                f"{BASE_URL}{ROUTE}", wait_until="networkidle"
            )
            try:
                await page.get_by_text(
                    "Normal working pattern"
                ).first.wait_for(timeout=20_000)
            except Exception as exc:
                all_failures.append(
                    f"[{label}] pattern block never rendered: {exc}"
                )
                await page.screenshot(
                    path=str(SCREENSHOTS / f"{label}-no-block.png")
                )
            else:
                await page.wait_for_timeout(300)
                cards = await page.evaluate(MEASURE_JS)
                failures = check(cards, label)
                if failures:
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-failure.png")
                    )
                    all_failures.extend(failures)
                else:
                    print(
                        f"[{label}] OK — {len(cards)} narrow cards fit, "
                        "align, and use the narrow label width."
                    )
            await context.close()
        finally:
            await browser.close()

    if all_failures:
        print("\nFAIL — narrow-card layout regressions:")
        for m in all_failures:
            print("  -", m)
        print(f"\nScreenshots: {SCREENSHOTS}")
        return 1
    print("\nPASS — narrow cards keep the grid aligned and inside the card.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
