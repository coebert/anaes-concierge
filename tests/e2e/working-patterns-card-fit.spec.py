"""
End-to-end test: the working-pattern grid must fit inside its staff card
on desktop, tablet, and mobile.

For every rendered "Normal working pattern" block, we assert that every
row (header + all data strips) has its right edge at or inside the
containing card's inner content edge. Any row overflowing to the right
is a layout regression — the grid has grown wider than the card.

Runs against the real app at three viewport widths, using the same
Supabase session-injection pattern as the other alignment specs.

Run with:
  python3 tests/e2e/working-patterns-card-fit.spec.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE_URL = "http://localhost:8080"
ROUTE = "/staff/working-patterns"

SCREENSHOTS = Path("/tmp/browser/working-patterns-card-fit")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ("desktop", 1280, 1800),
    ("tablet", 820, 1180),
    ("mobile", 390, 900),
]

# Allow sub-pixel rounding from getBoundingClientRect().
PIXEL_TOLERANCE = 1


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


async def measure_overflows(page) -> list[dict]:
    """
    For every pattern block, return the card's inner right edge (content
    box, i.e. accounting for padding) and each row's right edge, so we
    can flag overflows.
    """
    return await page.evaluate(
        """
        () => {
          const blocks = [...document.querySelectorAll('div.border-t')]
            .filter(b => b.textContent && b.textContent.includes('Normal working pattern'));

          return blocks.map((block, index) => {
            // Card = the outer rounded-xl container.
            const card = block.closest('[class*="rounded-xl"]');
            const cardRect = card ? card.getBoundingClientRect() : null;
            let cardInnerRight = cardRect ? cardRect.right : null;
            if (card && cardRect) {
              const cs = getComputedStyle(card);
              const pr = parseFloat(cs.paddingRight) || 0;
              const br = parseFloat(cs.borderRightWidth) || 0;
              cardInnerRight = cardRect.right - pr - br;
            }

            // Card title for debugging.
            const t = card && card.querySelector('.leading-tight');
            const title = (t && t.textContent || '').trim();

            const rows = [...block.querySelectorAll(':scope > div.flex.items-center.gap-2')];
            const rowData = rows.map(r => {
              const labelEl = r.querySelector(':scope > div.w-24');
              const rect = r.getBoundingClientRect();
              return {
                label: (labelEl && labelEl.textContent || '').trim() || '(header)',
                right: rect.right,
                width: rect.width,
              };
            });

            return {
              index,
              title,
              cardRight: cardRect ? cardRect.right : null,
              cardInnerRight,
              cardWidth: cardRect ? cardRect.width : null,
              rows: rowData,
            };
          });
        }
        """
    )


def check_fit(cards, viewport):
    failures: list[str] = []
    if not cards:
        failures.append(f"[{viewport}] no working-pattern blocks rendered")
        return failures

    for card in cards:
        if card["cardInnerRight"] is None:
            failures.append(
                f"[{viewport}] card '{card['title']}' has no measurable bounds"
            )
            continue
        limit = card["cardInnerRight"]
        for row in card["rows"]:
            overflow = row["right"] - limit
            if overflow > PIXEL_TOLERANCE:
                failures.append(
                    f"[{viewport}] card '{card['title']}' row "
                    f"{row['label']!r} overflows card by {overflow:.1f}px "
                    f"(row.right={row['right']:.1f}, "
                    f"card.innerRight={limit:.1f}, "
                    f"cardWidth={card['cardWidth']:.1f})"
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

    all_failures: list[str] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            for label, width, height in VIEWPORTS:
                context = await browser.new_context(
                    viewport={"width": width, "height": height}
                )
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
                        f"[{label}] Normal working pattern block never rendered: {exc}"
                    )
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-no-block.png")
                    )
                    await context.close()
                    continue

                await page.wait_for_timeout(300)
                cards = await measure_overflows(page)
                failures = check_fit(cards, label)
                if failures:
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-overflow.png")
                    )
                    all_failures.extend(failures)
                else:
                    print(
                        f"[{label}] OK — {len(cards)} pattern blocks, "
                        "grid fits inside every card."
                    )
                await context.close()
        finally:
            await browser.close()

    if all_failures:
        print("\nFAIL — working-pattern grid overflows card boundaries:")
        for m in all_failures:
            print("  -", m)
        print(f"\nScreenshots: {SCREENSHOTS}")
        return 1
    print("\nPASS — grid fits inside every card on desktop, tablet, and mobile.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
