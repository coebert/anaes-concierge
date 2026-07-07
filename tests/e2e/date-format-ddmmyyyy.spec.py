"""
End-to-end guard for British DD/MM/YYYY date rendering.

Visits the rota + CLWRota admin pages that render dates and asserts:

  1. Every `NN/NN/NNNN` token found in visible text is a valid British
     date — day in 01–31, month in 01–12. A US-locale regression
     ("05/26/2026" style) would produce a month > 12 and fail here.

  2. No "26 May 2026" / "26 Jul 26" style short-month text leaks onto
     these pages. The DD/MM/YYYY helpers replaced those; if a future
     edit drops back to `toLocaleDateString({ month: "short" })` this
     test catches it.

  3. No `MM/DD/YYYY` locale-default appearance: we look for the classic
     tell — `NN/NN/NNNN` where the first pair is 13–31 AND the second
     pair is 01–12 would silently be interpreted as valid DD/MM/YYYY,
     so we can't detect that case directly. But the "day > 12" check
     in (1) covers the tell-tale reversed dates for any date with
     month > 12 after swap, i.e. dates where the true day is 13–31 in
     Jan–Sep would still pass — that ambiguity is inherent. We compensate
     by adding (2), which flags any lingering non-numeric British long
     form that would have been the "safe" render for those ambiguous
     days.

Skips cleanly if no Lovable Supabase session is injected (matches the
convention used by the working-patterns e2e tests).

Run with:
  python3 tests/e2e/date-format-ddmmyyyy.spec.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE_URL = "http://localhost:8080"

# Pages that render dates. Each entry: (label, path, wait-for-selector-text).
# The wait-for text is a small, stable string we know appears on the page
# once its main content has hydrated — it avoids racing the DOM assertion.
PAGES = [
    ("global-calendar", "/calendar", None),
    ("coordinator-rota", "/coordinator/rota", None),
    ("coordinator-duties", "/coordinator/duties", None),
    ("admin-access-requests", "/admin/access-requests", None),
    ("clwrota-status", "/admin/clwrota-status", None),
    ("clwrota-metrics", "/admin/clwrota-metrics", None),
    ("clwrota-step-status", "/admin/clwrota-step-status", None),
]

SCREENSHOTS = Path("/tmp/browser/date-format-ddmmyyyy")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

# Any three groups of digits separated by slashes, with 1–4 digits per group,
# so we catch both DD/MM/YYYY and any accidental MM/DD/YYYY or 1/1/26 slip.
SLASH_DATE_RE = re.compile(r"\b(\d{1,4})/(\d{1,4})/(\d{1,4})\b")

# "26 May 2026", "26 Jul 26", "Mon 26 May", etc. — the short-month form
# that the pre-audit code produced via `{ month: 'short' }`. Any hit here
# indicates a locale-default render has crept back onto a page under test.
SHORT_MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
SHORT_MONTH_DATE_RE = re.compile(
    rf"\b\d{{1,2}}\s+(?:{SHORT_MONTHS})\s+\d{{2,4}}\b"
)

# Text nodes we deliberately don't audit — e.g. the app's own copyright /
# help text may mention a month name in prose. Keep this list tight so the
# guard stays meaningful.
IGNORED_TEXT_SUBSTRINGS: list[str] = []


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


async def visible_text(page) -> str:
    """Return the innerText of <main>, falling back to <body>."""
    return await page.evaluate(
        """
        () => {
          const main = document.querySelector('main');
          const root = main ?? document.body;
          return root ? root.innerText : '';
        }
        """
    )


def audit_text(label: str, text: str) -> list[str]:
    """Return a list of human-readable violation messages (empty = pass)."""
    problems: list[str] = []

    # (1) Every slash-date must be a valid DD/MM/YYYY.
    for match in SLASH_DATE_RE.finditer(text):
        a, b, c = match.group(1), match.group(2), match.group(3)
        # Four-digit-first is an ISO-ish 2026/05/26 — we don't render that
        # anywhere in the app, so flag it too.
        if len(a) == 4:
            problems.append(
                f"[{label}] found '{match.group(0)}' — looks like YYYY/MM/DD; "
                f"expected DD/MM/YYYY."
            )
            continue
        if len(c) != 4:
            problems.append(
                f"[{label}] found '{match.group(0)}' — year is not 4 digits; "
                f"expected DD/MM/YYYY."
            )
            continue
        try:
            day = int(a)
            month = int(b)
        except ValueError:  # pragma: no cover — regex guarantees digits
            continue
        if not (1 <= day <= 31):
            problems.append(
                f"[{label}] found '{match.group(0)}' — day {day} out of range."
            )
        if not (1 <= month <= 12):
            # This is the strongest tell of a US-locale MM/DD/YYYY leak:
            # e.g. "26/05/2026" reversed becomes "05/26/2026" and the
            # middle group is 26, i.e. > 12 in the day slot.
            problems.append(
                f"[{label}] found '{match.group(0)}' — month {month} > 12. "
                f"Likely a MM/DD/YYYY locale-default regression."
            )

    # (2) No short-month "26 May 2026" leaks.
    for match in SHORT_MONTH_DATE_RE.finditer(text):
        snippet = match.group(0)
        if any(sub in snippet for sub in IGNORED_TEXT_SUBSTRINGS):
            continue
        problems.append(
            f"[{label}] found short-month date '{snippet}' — expected DD/MM/YYYY."
        )

    return problems


async def main() -> int:
    if os.environ.get("LOVABLE_BROWSER_AUTH_STATUS") not in ("injected", None):
        print(
            "SKIP: LOVABLE_BROWSER_AUTH_STATUS="
            f"{os.environ.get('LOVABLE_BROWSER_AUTH_STATUS')}; "
            "no authenticated session available."
        )
        return 0

    all_problems: list[str] = []
    pages_hit = 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            context = await browser.new_context(
                viewport={"width": 1280, "height": 1800}
            )
            page = await context.new_page()
            await restore_session(context, page)

            for label, path, wait_text in PAGES:
                try:
                    await page.goto(
                        f"{BASE_URL}{path}", wait_until="networkidle"
                    )
                except Exception as exc:
                    all_problems.append(
                        f"[{label}] navigation to {path} failed: {exc}"
                    )
                    continue

                if wait_text:
                    try:
                        await page.get_by_text(wait_text).first.wait_for(
                            timeout=15_000
                        )
                    except Exception:
                        # Fall through — audit whatever text did render.
                        pass

                # Small settle so any async data / dates finish rendering.
                await page.wait_for_timeout(500)

                # If we got bounced to /auth or /login, treat as a skip for
                # this page — the session might have expired mid-run.
                current = page.url
                if any(seg in current for seg in ("/auth", "/login")):
                    print(
                        f"[{label}] SKIP — redirected to {current} "
                        f"(no session for this route)."
                    )
                    continue

                text = await visible_text(page)
                if not text.strip():
                    all_problems.append(
                        f"[{label}] {path} rendered no visible text."
                    )
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-empty.png")
                    )
                    continue

                pages_hit += 1
                problems = audit_text(label, text)
                if problems:
                    all_problems.extend(problems)
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-fail.png")
                    )
                else:
                    print(f"[{label}] OK — DD/MM/YYYY on {path}.")
        finally:
            await browser.close()

    if pages_hit == 0 and not all_problems:
        print("SKIP: no audited page rendered content (all redirected).")
        return 0

    if all_problems:
        print("\nFAIL — date-format regressions:")
        for msg in all_problems:
            print("  -", msg)
        print(f"\nScreenshots: {SCREENSHOTS}")
        return 1

    print(f"\nPASS — DD/MM/YYYY consistent across {pages_hit} pages.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
