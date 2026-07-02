"""
End-to-end test: long staff names and long specialty labels must not
break the Working Patterns card layout.

The fixture injects three consultants whose names are far longer than
any real name, plus specialty labels that are 60+ characters long. For
every fixture card we assert:

  1. Card width matches the grid width the layout budgets for it
     (a long name must not stretch the card horizontally).
  2. The pattern-grid rows (header, Working AM/PM, Private/SAG, SPA,
     On-call) still share the same 5 column x-positions and widths
     within a 1px tolerance.
  3. No pattern row overflows past the card's inner right edge on
     desktop, tablet, or mobile.
  4. The rendered card title is visually clipped/truncated — the DOM
     text length exceeds the rendered element's client width, proving
     the `truncate` guard is still in effect.

Run with:
  python3 tests/e2e/working-patterns-long-labels.spec.py
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

SCREENSHOTS = Path("/tmp/browser/working-patterns-long-labels")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

VIEWPORTS = [
    ("desktop", 1280, 1800),
    ("tablet", 820, 1180),
    ("mobile", 390, 900),
]

PIXEL_TOLERANCE = 1

# --- Fixture data ------------------------------------------------------------

STAFF_LONG_NAME_ID = "aaaa1111-1111-1111-1111-111111111111"
STAFF_LONG_SPEC_ID = "bbbb2222-2222-2222-2222-222222222222"
STAFF_BOTH_ID = "cccc3333-3333-3333-3333-333333333333"

LONG_NAME_A = (
    "Dr Aloysius-Bartholomew Ferdinand-Alexander "
    "Cunningham-Featherstonehaugh-Worthington III"
)
LONG_NAME_B = (
    "Dr Beatrice-Persephone Isadora-Wilhelmina "
    "Kensington-Wentworth-Ashcombe-Marlborough"
)
LONG_NAME_C = (
    "Dr Cornelius-Maximilian Peregrine-Octavian "
    "Fortescue-Winchester-Pemberton-Longbottom OBE"
)

LONG_SPECIALTY_1 = (
    "Complex Paediatric Cardiothoracic Neurosurgical Anaesthesia (Extra Long)"
)
LONG_SPECIALTY_2 = (
    "Maxillofacial-Reconstructive-Microvascular-Anaesthesia-Subspecialty"
)

PROFILES = [
    {
        "id": STAFF_LONG_NAME_ID,
        "full_name": LONG_NAME_A,
        "grade": "consultant",
        "active": True,
        "left_at": None,
    },
    {
        "id": STAFF_LONG_SPEC_ID,
        "full_name": LONG_NAME_B,
        "grade": "consultant",
        "active": True,
        "left_at": None,
    },
    {
        "id": STAFF_BOTH_ID,
        "full_name": LONG_NAME_C,
        "grade": "consultant",
        "active": True,
        "left_at": None,
    },
]

THEATRES = [
    {"id": "t1", "name": "Theatre 1", "kind": "main"},
]
SPECIALTIES = [
    {"id": "sp1", "name": LONG_SPECIALTY_1},
    {"id": "sp2", "name": LONG_SPECIALTY_2},
]


def _assign(staff_id: str, date: str, half: str | None,
            duty: str = "theatre", session_id: str | None = None):
    return {
        "staff_id": staff_id,
        "duty_type": duty,
        "theatre_session_id": session_id,
        "session_date": date,
        "session": half,
    }


def build_theatre_sessions() -> list[dict]:
    # Two theatre sessions per Monday so long-specialty labels flow into
    # the LocationBreakdown / SpecialtyList rows.
    sessions = []
    base = dt.date(2026, 1, 5)
    for w in range(6):
        d = (base + dt.timedelta(days=7 * w)).isoformat()
        sessions.append({
            "id": f"ts-{w}-a",
            "theatre_id": "t1",
            "specialty_id": "sp1",
            "is_non_sag": False,
            "session_date": d,
        })
        sessions.append({
            "id": f"ts-{w}-b",
            "theatre_id": "t1",
            "specialty_id": "sp2",
            "is_non_sag": False,
            "session_date": d,
        })
    return sessions


THEATRE_SESSIONS = build_theatre_sessions()


def build_assignments() -> list[dict]:
    rows: list[dict] = []
    base = dt.date(2026, 1, 5)  # Monday
    for w in range(6):
        def plus(n: int) -> str:
            return (base + dt.timedelta(days=7 * w + n)).isoformat()

        # All three consultants: regular Mon AM + Wed PM patterns so the
        # grid has both AM and PM cells to align.
        for sid in (STAFF_LONG_NAME_ID, STAFF_LONG_SPEC_ID, STAFF_BOTH_ID):
            rows.append(_assign(sid, plus(0), "am",
                                session_id=f"ts-{w}-a"))
            rows.append(_assign(sid, plus(2), "pm",
                                session_id=f"ts-{w}-b"))
            # Friday on-call every other week.
            if w % 2 == 0:
                rows.append(_assign(sid, plus(4), "pm",
                                    duty="general_consultant_oncall"))
    return rows


ASSIGNMENTS = build_assignments()


# --- REST intercept ----------------------------------------------------------

async def handle_rest(route: Route) -> None:
    url = route.request.url
    path = url.split("/rest/v1/", 1)[-1].split("?", 1)[0]

    def json_ok(body):
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
        return await json_ok(PROFILES)
    if path == "theatres":
        return await json_ok(THEATRES)
    if path == "specialties":
        return await json_ok(SPECIALTIES)
    if path == "theatre_sessions":
        return await json_ok(THEATRE_SESSIONS)
    if path == "rota_assignments":
        return await json_ok(ASSIGNMENTS)
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

MEASURE_JS = r"""
() => {
  // shadcn Card is uniquely identified by `.bg-card` on the outer element.
  const cards = [...document.querySelectorAll('.bg-card')]
    .filter(c => c.querySelector('div.border-t') &&
                 c.textContent.includes('Normal working pattern'));

  return cards.map((card, index) => {
    const cardRect = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const pr = parseFloat(cs.paddingRight) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const cardInnerRight = cardRect.right - pr - br;

    const titleEl = card.querySelector('.leading-tight');
    const title = (titleEl?.textContent || '').trim();
    // scrollWidth > clientWidth => truncation is active.
    const titleScroll = titleEl ? titleEl.scrollWidth : 0;
    const titleClient = titleEl ? titleEl.clientWidth : 0;

    const block = card.querySelector('div.border-t');
    const rows = [...block.querySelectorAll(':scope > div.flex.items-center.gap-2')];
    const rowData = rows.map(r => {
      const labelEl = r.querySelector(':scope > div.w-24');
      const cells = [...r.querySelectorAll(':scope > div.flex.gap-1 > div')];
      const rect = r.getBoundingClientRect();
      return {
        label: (labelEl?.textContent || '').trim() || '(header)',
        rowRight: rect.right,
        xs: cells.map(c => c.getBoundingClientRect().left),
        widths: cells.map(c => c.getBoundingClientRect().width),
      };
    }).filter(r => r.xs.length === 5);

    return {
      index,
      title,
      titleScroll,
      titleClient,
      cardWidth: cardRect.width,
      cardInnerRight,
      rows: rowData,
    };
  });
}
"""


async def measure(page) -> list[dict]:
    return await page.evaluate(MEASURE_JS)


def check(cards, viewport, required_prefixes):
    failures: list[str] = []
    fixture = [c for c in cards
               if any(c["title"].startswith(p) for p in required_prefixes)]
    if len(fixture) < len(required_prefixes):
        failures.append(
            f"[{viewport}] expected {len(required_prefixes)} fixture cards, "
            f"found {len(fixture)}"
        )

    # (1) All fixture card widths should match (long names must not
    # stretch a single card).
    if fixture:
        widths = [c["cardWidth"] for c in fixture]
        wmax, wmin = max(widths), min(widths)
        if wmax - wmin > PIXEL_TOLERANCE:
            failures.append(
                f"[{viewport}] fixture card widths diverge: "
                f"min={wmin:.1f} max={wmax:.1f} (long name stretched a card)"
            )

    for card in fixture:
        # (4) Long titles must be truncated (rendered width < full text width).
        if card["titleScroll"] - card["titleClient"] <= 0:
            failures.append(
                f"[{viewport}] card '{card['title'][:40]}…' title is NOT "
                f"truncated (scrollWidth={card['titleScroll']}, "
                f"clientWidth={card['titleClient']})"
            )

        rows = card["rows"]
        if len(rows) < 2:
            failures.append(
                f"[{viewport}] card '{card['title'][:40]}…' has <2 rows"
            )
            continue
        ref = rows[0]

        # (2) Column alignment.
        for row in rows[1:]:
            for col in range(5):
                dx = abs(row["xs"][col] - ref["xs"][col])
                dw = abs(row["widths"][col] - ref["widths"][col])
                if dx > PIXEL_TOLERANCE or dw > PIXEL_TOLERANCE:
                    failures.append(
                        f"[{viewport}] card '{card['title'][:30]}…' row "
                        f"{row['label']!r} col {col} misaligned: "
                        f"Δx={dx:.1f} Δw={dw:.1f}"
                    )

        # (3) No overflow past card inner right.
        for row in rows:
            over = row["rowRight"] - card["cardInnerRight"]
            if over > PIXEL_TOLERANCE:
                failures.append(
                    f"[{viewport}] card '{card['title'][:30]}…' row "
                    f"{row['label']!r} overflows card by {over:.1f}px"
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

    # First 20 chars of each name are unique — use as identifiers.
    required = [LONG_NAME_A[:20], LONG_NAME_B[:20], LONG_NAME_C[:20]]
    all_failures: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            for label, width, height in VIEWPORTS:
                context = await browser.new_context(
                    viewport={"width": width, "height": height}
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
                    await context.close()
                    continue

                await page.wait_for_timeout(300)
                cards = await measure(page)
                failures = check(cards, label, required)
                if failures:
                    await page.screenshot(
                        path=str(SCREENSHOTS / f"{label}-failure.png")
                    )
                    all_failures.extend(failures)
                else:
                    n = sum(
                        1 for c in cards
                        if any(c["title"].startswith(p) for p in required)
                    )
                    print(
                        f"[{label}] OK — {n} long-label cards fit, "
                        "align, and truncate correctly."
                    )
                await context.close()
        finally:
            await browser.close()

    if all_failures:
        print("\nFAIL — long-label layout regressions:")
        for m in all_failures:
            print("  -", m)
        print(f"\nScreenshots: {SCREENSHOTS}")
        return 1
    print("\nPASS — long staff names & specialty labels keep the layout intact.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
