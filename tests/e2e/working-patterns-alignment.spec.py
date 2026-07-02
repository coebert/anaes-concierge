"""
Layout / visual-regression test for the Staff → Working patterns page.

For every staff card that renders a "Normal working pattern" block, this
test asserts that all rows (Working AM/PM, Private/SAG, SPA, On-call) —
plus the shared weekday header — align to the SAME five column x-positions
with the SAME cell width. This is the invariant the user relies on: the
Mon–Fri columns must line up under each other for every staff member.

It runs the assertion at three viewport widths (desktop, tablet, mobile)
so future CSS changes that only regress a single breakpoint are caught.

Run with:
  python3 tests/e2e/working-patterns-alignment.spec.py

Requires an injected Lovable Supabase session (LOVABLE_BROWSER_* env
vars); the script exits 0 with a "skipped" message if none is present,
so CI without a session doesn't red-flag the run.
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

SCREENSHOTS = Path("/tmp/browser/working-patterns-alignment")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ("desktop", 1280, 1800),
    ("tablet", 820, 1180),
    ("mobile", 390, 900),
]

# Tolerance for sub-pixel rounding in getBoundingClientRect().
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


async def measure_cards(page) -> list[dict]:
    """Return per-card row geometry for every Normal working pattern block."""
    return await page.evaluate(
        """
        () => {
          // Find every "Normal working pattern" block (one per consultant card).
          const blocks = [...document.querySelectorAll('div.border-t')]
            .filter(b => b.textContent && b.textContent.includes('Normal working pattern'));

          return blocks.map((block, index) => {
            // The header + each strip is a direct child .flex.items-center.gap-2.
            // A row's cells are the divs inside the inner .flex.gap-1 wrapper.
            const rows = [...block.querySelectorAll(':scope > div.flex.items-center.gap-2')];
            const rowData = rows.map(r => {
              const labelEl = r.querySelector(':scope > div.w-24');
              const cells = [...r.querySelectorAll(':scope > div.flex.gap-1 > div')];
              return {
                label: (labelEl?.textContent || '').trim(),
                xs: cells.map(c => c.getBoundingClientRect().left),
                widths: cells.map(c => c.getBoundingClientRect().width),
              };
            }).filter(r => r.xs.length === 5); // drop empty label-only rows
            return { index, rows: rowData };
          });
        }
        """
    )


def check_alignment(cards: list[dict], viewport: str) -> list[str]:
    """Return a list of human-readable failure messages (empty = pass)."""
    failures: list[str] = []
    if not cards:
        failures.append(f"[{viewport}] no consultant pattern blocks found")
        return failures

    for card in cards:
        rows = card["rows"]
        if len(rows) < 2:
            failures.append(
                f"[{viewport}] card #{card['index']} has fewer than 2 measured rows"
            )
            continue

        ref = rows[0]
        for row in rows[1:]:
            for col in range(5):
                dx = abs(row["xs"][col] - ref["xs"][col])
                dw = abs(row["widths"][col] - ref["widths"][col])
                if dx > PIXEL_TOLERANCE or dw > PIXEL_TOLERANCE:
                    failures.append(
                        f"[{viewport}] card #{card['index']} row "
                        f"{row['label']!r} col {col} misaligned: "
                        f"x={row['xs'][col]:.1f} vs {ref['xs'][col]:.1f} "
                        f"(Δ={dx:.1f}px), w={row['widths'][col]:.1f} vs "
                        f"{ref['widths'][col]:.1f} (Δ={dw:.1f}px)"
                    )
    return failures


async def main() -> int:
    if os.environ.get("LOVABLE_BROWSER_AUTH_STATUS") not in ("injected", None):
        # signed_out / external_unmanaged / no_supabase — can't reach the page.
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

                # Wait for at least one pattern block to render.
                try:
                    await page.get_by_text(
                        "Normal working pattern"
                    ).first.wait_for(timeout=20_000)
                except Exception as exc:
                    all_failures.append(
                        f"[{label}] Normal working pattern block never rendered: {exc}"
                    )
                    await page.screenshot(path=str(SCREENSHOTS / f"{label}-no-block.png"))
                    await context.close()
                    continue

                # Small settle for layout post-hydration.
                await page.wait_for_timeout(300)

                cards = await measure_cards(page)
                failures = check_alignment(cards, label)
                if failures:
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-failure.png")
                    )
                    all_failures.extend(failures)
                else:
                    print(
                        f"[{label}] OK — {len(cards)} pattern blocks, "
                        f"columns aligned across all rows."
                    )

                await context.close()
        finally:
            await browser.close()

    if all_failures:
        print("\nFAIL — weekday-column alignment regressions:")
        for msg in all_failures:
            print("  -", msg)
        print(f"\nScreenshots: {SCREENSHOTS}")
        return 1

    print("\nPASS — weekday columns align on desktop, tablet, and mobile.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
