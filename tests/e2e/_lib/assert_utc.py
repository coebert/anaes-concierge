"""
UTC drift guard for the Playwright E2E specs — parity with the Vitest-side
`src/test/assert-utc-hook.ts` / `src/test/assert-utc.ts`.

Why this exists
---------------
Wellbeing calculations bucket rows into calendar days via
`decided_at.slice(0, 10)` (a UTC ISO string) and compare against window
bounds built from `new Date(...)`. If EITHER the Python runner OR the
Chromium browser context runs in a non-UTC timezone, off-by-one drift at
the day boundary produces flaky pass/fail on a developer laptop and in
CI — the exact class of bug the Vitest suite already guards against.

This module enforces the same invariant for the E2E layer:

  * At import time it pins the Python process to `TZ=UTC` (via
    `os.environ["TZ"]` + `time.tzset()` on POSIX) and asserts the
    resulting offset is zero. If either check fails it raises
    immediately — any spec that imports this module (directly or
    transitively via `_lib.signed_in`) fails loudly at load, before any
    Playwright work begins, with a clear message pointing at the fix.
  * `PLAYWRIGHT_TIMEZONE_ID = "UTC"` is exported for callers that build
    their own `browser.new_context(...)` — pass it as `timezone_id` so
    every `Date` inside the page also resolves against UTC, regardless
    of the host OS. `_lib.signed_in.signed_in_context` already applies
    it.
  * `assert_browser_tz_utc(page)` runs a one-line `new Date()` probe
    inside the page and asserts the browser's `getTimezoneOffset()` is
    zero — catches a regression that drops `timezone_id="UTC"` from a
    hand-rolled `new_context` call.

Usage from a spec:

    # Explicit belt-and-braces guard at the top of a spec.
    from _lib.assert_utc import ensure_utc, assert_browser_tz_utc
    ensure_utc()
    # ... later, inside the async body, after `page` is created:
    await assert_browser_tz_utc(page)

Specs that go through `signed_in_context` get `ensure_utc()` for free —
importing `_lib.signed_in` triggers it as a side effect.
"""

from __future__ import annotations

import os
import time
from typing import Final

from playwright.async_api import Page

PLAYWRIGHT_TIMEZONE_ID: Final[str] = "UTC"


def _current_offset_seconds() -> int:
    """Return the local timezone's UTC offset in seconds at "now"."""
    # `time.localtime().tm_gmtoff` reflects the CURRENT offset (DST-aware)
    # after `time.tzset()`, so it beats reading the static `time.timezone`
    # which is fixed to the non-DST offset.
    return time.localtime().tm_gmtoff


def ensure_utc() -> None:
    """
    Pin the Python process to UTC and raise if the pin didn't stick.

    Idempotent — safe to call from multiple modules; the second call
    just re-verifies. Raises `RuntimeError` on drift so the failure is
    obvious in the spec's traceback.
    """
    os.environ["TZ"] = "UTC"
    # `time.tzset()` is POSIX-only. On Windows the env-var write above is
    # enough for new subprocesses (Playwright's Chromium inherits it via
    # `env=os.environ`), but the Python process itself keeps its startup
    # timezone. That's fine here — the offset check below runs against
    # `time.localtime()` and will fail loudly on Windows if the runner
    # isn't already UTC, prompting the operator to set `TZ=UTC` before
    # invoking the spec.
    tzset = getattr(time, "tzset", None)
    if callable(tzset):
        tzset()

    offset = _current_offset_seconds()
    tz = os.environ.get("TZ")
    if tz != "UTC" or offset != 0:
        raise RuntimeError(
            "E2E timezone drift detected: "
            f"os.environ['TZ']={tz!r}, "
            f"time.localtime().tm_gmtoff={offset} seconds. "
            "Expected UTC (offset 0). "
            "Run the spec with `TZ=UTC python3 tests/e2e/<spec>.py`, "
            "or fix your shell profile — wellbeing calendar-day "
            "assertions drift by ±1 day at midnight otherwise."
        )


async def assert_browser_tz_utc(page: Page) -> None:
    """
    Assert the Chromium context backing `page` also resolves `Date` in
    UTC. Catches a regression that drops `timezone_id="UTC"` from a
    manually built `new_context(...)` call.
    """
    offset = await page.evaluate("() => new Date().getTimezoneOffset()")
    if offset != 0:
        raise RuntimeError(
            "E2E browser timezone drift detected: "
            f"page.evaluate('new Date().getTimezoneOffset()') = {offset}. "
            "Expected 0 (UTC). Pass `timezone_id=\"UTC\"` when calling "
            "`browser.new_context(...)`, or use "
            "`_lib.signed_in.signed_in_context` which sets it for you."
        )


# Side-effect: importing this module pins the runner to UTC. Any spec
# (or helper such as `_lib.signed_in`) that imports it gets the guard
# without an explicit call. An explicit `ensure_utc()` at the top of a
# spec still helps: it re-runs the check after any later env mutation.
ensure_utc()
