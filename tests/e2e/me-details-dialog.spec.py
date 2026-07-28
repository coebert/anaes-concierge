"""
E2E: Medical examiner details dialog — the AM/PM metadata shown in the
popover MUST match the calendar cell it was opened from.

What this locks in
------------------
The global calendar (/calendar) renders a dedicated "Medical examiner"
row. Each cell hosts an <Info /> button (data-testid
`medical-examiner-details-trigger`). Clicking it opens a dialog
(data-testid `medical-examiner-details-panel`) whose "Session" line reads
"AM (08:00–13:00)" or "PM (13:00–18:00)" depending on the persisted
`session` half of that specific `rota_assignments` row.

The regression this guards is the AM/PM contract enforced by
`filterAssignmentsForCell` and `SESSION_TIMES`: an AM row must never open
a PM dialog and vice versa, even when the same staff member has an ME
session on both halves of neighbouring days. It complements the pure-JS
unit tests in `me-cell-visibility.test.ts` by driving the real dialog.

Fixture strategy
----------------
Two ME rows are seeded in `rota_assignments`:
  * AM on the current week's Monday
  * PM on the current week's Tuesday
so the calendar's default (this week) view renders both cells.
`listActiveStaffSafe` is mocked via the TanStack `/_serverFn/*` envelope
so the row renders with a real staff name in the cell.

Screenshots land in /tmp/browser/me-details-dialog/.
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.async_api import Route, async_playwright  # noqa: E402

from _lib.assert_utc import ensure_utc  # noqa: E402
from _lib.signed_in import (  # noqa: E402
    BASE_URL,
    FAKE_USER_ID,
    signed_in_context,
)

SHOTS = Path("/tmp/browser/me-details-dialog")
SHOTS.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Dates — pinned to this week (UTC) so the default calendar view renders
# them without needing to drive the PeriodNav.
# ---------------------------------------------------------------------------

def _monday_of_this_week() -> date:
    today = date.today()  # process is TZ=UTC (ensure_utc + signed_in pin)
    return today - timedelta(days=today.weekday())


MONDAY = _monday_of_this_week()
TUESDAY = MONDAY + timedelta(days=1)

STAFF_ID = FAKE_USER_ID
STAFF_NAME = "E2E Signed-in User"

ME_ROW_AM = {
    "id": "11111111-1111-1111-1111-111111111111",
    "staff_id": STAFF_ID,
    "session": "am",
    "session_date": MONDAY.isoformat(),
    "duty_type": "medical_examiner",
    "theatre_session_id": None,
    "role_on_list": "non_clinical",
    "supervisor_id": None,
    "clwrota_external_id": "clwrota-me-mon|am",
    "source": "clwrota",
    "notes": None,
    "extra_type": None,
    "locally_modified": False,
    "is_non_sag": False,
    "created_at": "2026-05-01T00:00:00Z",
    "updated_at": "2026-05-01T00:00:00Z",
}
ME_ROW_PM = {
    **ME_ROW_AM,
    "id": "22222222-2222-2222-2222-222222222222",
    "session": "pm",
    "session_date": TUESDAY.isoformat(),
    "clwrota_external_id": "clwrota-me-tue|pm",
}


# ---------------------------------------------------------------------------
# TanStack `/_serverFn/*` — reuse the seroval envelope shape from
# passkeys.spec.py. `listActiveStaffSafe` is the only server-fn call the
# calendar page depends on for cell rendering.
# ---------------------------------------------------------------------------

_SEROVAL_ENCODER = """\
import { toCrossJSON } from '/dev-server/node_modules/seroval/dist/esm/production/index.mjs';
const value = JSON.parse(process.argv[2]);
const refs = new Map();
process.stdout.write(JSON.stringify(
  toCrossJSON({ result: value, error: null, context: {} }, { refs }),
));
"""


def _encoder_path() -> Path:
    p = SHOTS / "_encoder.mjs"
    if not p.exists():
        p.write_text(_SEROVAL_ENCODER)
    return p


def seroval_encode(value: Any) -> str:
    proc = subprocess.run(
        ["node", str(_encoder_path()), json.dumps(value)],
        capture_output=True, text=True, check=True,
    )
    return proc.stdout


ACTIVE_STAFF = [
    {
        "id": STAFF_ID,
        "full_name": STAFF_NAME,
        "grade": "consultant",
        "training_level": None,
        "active": True,
        "start_date": "2020-01-01",
    },
]


async def handle_serverfn(route: Route) -> None:
    # Only listActiveStaffSafe needs a real payload on this page; every
    # other server-fn call the calendar might issue gets an empty array
    # which the client's `(rows ?? []).map(...)` handles safely.
    body = seroval_encode(ACTIVE_STAFF)
    await route.fulfill(
        status=200,
        headers={"content-type": "application/json", "x-tss-serialized": "true"},
        body=body,
    )


# ---------------------------------------------------------------------------
# PostgREST — return the ME rows only for the spa/admin/ME query so
# unrelated `rota_assignments` reads (theatre, night on-call, etc.) still
# see an empty list.
# ---------------------------------------------------------------------------

def _wants_spa_admin(url: str) -> bool:
    # Client issues `duty_type=in.(spa,admin,medical_examiner)`.
    return "duty_type=in." in url and "medical_examiner" in url


async def handle_rota_assignments(route: Route) -> None:
    url = route.request.url
    if _wants_spa_admin(url):
        await route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps([ME_ROW_AM, ME_ROW_PM]),
        )
        return
    await route.fulfill(
        status=200, content_type="application/json", body="[]"
    )


# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

async def open_and_check_dialog(page, trigger_index: int, expect_session_text: str, expect_ext_id: str, shot: str) -> None:
    triggers = page.locator('[data-testid="medical-examiner-details-trigger"]')
    await triggers.nth(trigger_index).click()
    panel = page.locator('[data-testid="medical-examiner-details-panel"]')
    await panel.wait_for(state="visible", timeout=5_000)
    txt = await panel.inner_text()
    await page.screenshot(path=str(SHOTS / shot))
    assert expect_session_text in txt, (
        f"expected session line {expect_session_text!r} in dialog, got:\n{txt}"
    )
    # The opposite half-day label must NOT appear — this is the core
    # AM-vs-PM contract.
    opposite = "PM (13:00–18:00)" if "AM" in expect_session_text else "AM (08:00–13:00)"
    assert opposite not in txt, (
        f"dialog leaked {opposite!r} into a {expect_session_text!r} cell:\n{txt}"
    )
    assert expect_ext_id in txt, (
        f"expected CLWRota id {expect_ext_id!r} in dialog, got:\n{txt}"
    )
    assert STAFF_NAME in txt
    # Close for the next iteration.
    await page.keyboard.press("Escape")
    await panel.wait_for(state="hidden", timeout=5_000)


async def main() -> None:
    ensure_utc()
    async with async_playwright() as pw:
        browser, context, page = await signed_in_context(pw, roles=("staff",))
        # Server-fn mock (staff directory) — must be registered before
        # first navigation to /calendar so the initial fetch is caught.
        await context.route("**/_serverFn/**", handle_serverfn)
        # Override the generic rest handler for rota_assignments so we
        # can respond only to the ME query.
        await context.route(
            "**/rest/v1/rota_assignments*", handle_rota_assignments
        )

        try:
            await page.goto(
                f"{BASE_URL}/calendar", wait_until="domcontentloaded"
            )
            try:
                await page.wait_for_selector(
                    "text=Global calendar", timeout=15_000
                )
                await page.wait_for_selector(
                    'th:has-text("Medical examiner"), td:has-text("Medical examiner")',
                    timeout=15_000,
                )
            except Exception:
                await page.screenshot(path=str(SHOTS / "0_failure.png"))
                Path(SHOTS / "0_failure.html").write_text(await page.content())
                raise
            # Both ME cells rendered ⇒ exactly two info triggers.
            await page.wait_for_function(
                """
                () => document.querySelectorAll(
                    '[data-testid=medical-examiner-details-trigger]'
                ).length === 2
                """,
                timeout=8_000,
            )
            await page.screenshot(path=str(SHOTS / "0_calendar.png"))

            # Row order iterates day-by-day, AM before PM. Because we
            # seeded AM on Monday and PM on Tuesday, trigger 0 == AM,
            # trigger 1 == PM.
            await open_and_check_dialog(
                page,
                trigger_index=0,
                expect_session_text="AM (08:00–13:00)",
                expect_ext_id="clwrota-me-mon|am",
                shot="1_am_dialog.png",
            )
            await open_and_check_dialog(
                page,
                trigger_index=1,
                expect_session_text="PM (13:00–18:00)",
                expect_ext_id="clwrota-me-tue|pm",
                shot="2_pm_dialog.png",
            )
            print("OK — AM cell → AM dialog, PM cell → PM dialog")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
