"""
E2E: the "Audits & robustness" sidebar group renders in alphabetical order
(case-insensitive by label) and the ordering remains stable after
navigating into one of the items.

Run with:
  python3 tests/e2e/audits-menu-alphabetical.spec.py

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
GROUP_LABEL = "Audits & robustness"

SCREENSHOTS = Path("/tmp/browser/audits-menu-alphabetical")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


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


async def read_audits_items(page) -> list[dict]:
    """
    Return the labels + hrefs of every link rendered inside the
    "Audits & robustness" sidebar group, in DOM order.
    """
    return await page.evaluate(
        """
        (groupLabel) => {
          // Find the trigger button that carries the group label.
          const triggers = [...document.querySelectorAll('button')];
          const trigger = triggers.find(b => (b.textContent || '').trim() === groupLabel);
          if (!trigger) return { error: 'group trigger not found' };

          // Expand the collapsible if it isn't already open.
          const isOpen = trigger.getAttribute('data-state') === 'open'
            || trigger.closest('[data-state="open"]') !== null;
          if (!isOpen) trigger.click();

          // Walk up to the collapsible root, then find its content region.
          const root = trigger.closest('.group\\\\/collapsible') || trigger.parentElement;
          const content = root ? root.querySelector('[data-state="open"], [role="region"], .overflow-hidden') : null;
          const scope = content || root;
          if (!scope) return { error: 'group content not found' };

          const links = [...scope.querySelectorAll('a[href]')];
          return {
            items: links.map(a => ({
              label: (a.textContent || '').trim(),
              href: a.getAttribute('href') || '',
            })),
          };
        }
        """,
        GROUP_LABEL,
    )


def assert_alphabetical(items: list[dict]) -> None:
    labels = [i["label"] for i in items]
    sorted_labels = sorted(labels, key=lambda s: s.lower())
    if labels != sorted_labels:
        print("Actual order:", labels, file=sys.stderr)
        print("Sorted order:", sorted_labels, file=sys.stderr)
        raise AssertionError("Audits & robustness items are not alphabetical")


async def main() -> int:
    if os.environ.get("LOVABLE_BROWSER_AUTH_STATUS") != "injected":
        print("skipped: no injected Lovable Supabase session")
        return 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()

        await restore_session(context, page)
        await page.goto(f"{BASE_URL}/", wait_until="domcontentloaded")
        # Wait for sidebar to render.
        await page.wait_for_selector(f"button:has-text(\"{GROUP_LABEL}\")", timeout=10_000)

        first = await read_audits_items(page)
        if "error" in first:
            print(f"failed to read audits items: {first['error']}", file=sys.stderr)
            await page.screenshot(path=str(SCREENSHOTS / "no-group.png"))
            return 1

        items_before = first["items"]
        if len(items_before) < 2:
            print(f"expected multiple audit items, got: {items_before}", file=sys.stderr)
            return 1

        await page.screenshot(path=str(SCREENSHOTS / "1_initial.png"))
        assert_alphabetical(items_before)

        # Navigate into a middle item and verify the order remains stable.
        mid = items_before[len(items_before) // 2]
        await page.goto(f"{BASE_URL}{mid['href']}", wait_until="domcontentloaded")
        await page.wait_for_selector(f"button:has-text(\"{GROUP_LABEL}\")", timeout=10_000)

        second = await read_audits_items(page)
        if "error" in second:
            print(f"failed to re-read audits items: {second['error']}", file=sys.stderr)
            return 1

        items_after = second["items"]
        await page.screenshot(path=str(SCREENSHOTS / "2_after_nav.png"))
        assert_alphabetical(items_after)

        labels_before = [i["label"] for i in items_before]
        labels_after = [i["label"] for i in items_after]
        if labels_before != labels_after:
            print("Order changed after navigation!", file=sys.stderr)
            print("Before:", labels_before, file=sys.stderr)
            print("After: ", labels_after, file=sys.stderr)
            return 1

        print(f"OK: {len(items_before)} audit items alphabetical and stable after navigation")
        await browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
