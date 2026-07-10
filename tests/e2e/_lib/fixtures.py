"""
Deterministic test fixtures for E2E specs.

Everything here is a pure, hash-stable Python object graph so any spec that
withdraws (or otherwise mutates) a specific exception report knows *exactly*
which row it is touching, what the "before" and "after" wellbeing / stats
totals should look like, and which trainee owns the row.

Design notes
------------
- All IDs are fixed UUIDs so screenshots and log lines diff cleanly between
  runs, and so a spec can address a specific row by name (``EX_HOURS_OPEN``)
  rather than an array index that would drift when fixtures grow.
- Timestamps are ISO-8601 in UTC and pinned to a fixed "today" (``TODAY``)
  so ``due_by`` / ``overdue`` derivations are reproducible.
- ``exception_reports_after_withdraw(id)`` returns a NEW list — the caller
  never mutates the module-level fixture in place, so a single test file
  can run "before" and "after" assertions in either order without leakage.
- ``expected_exception_stats(rows)`` mirrors the arithmetic used by
  ``src/routes/_authenticated/exceptions.tsx`` (open = not resolved and not
  withdrawn, resolved = resolved, overdue = open with ``due_by < now``) so
  the E2E spec can assert against a computed truth, not hard-coded numbers
  that would silently drift if fixtures are edited.

Import as ``from _lib.fixtures import ...`` (mirrors ``_lib.signed_in``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from _lib.signed_in import FAKE_EMAIL, FAKE_USER_ID

# --------------------------------------------------------------------------
# Clock — a single pinned "now" so due_by / overdue are deterministic.
# --------------------------------------------------------------------------

TODAY = "2026-07-10"                    # matches the current date rule
NOW_ISO = f"{TODAY}T09:00:00Z"
_DAY = 86_400_000                        # ms

def _iso(offset_days: int) -> str:
    """ISO date `offset_days` from TODAY (positive = future)."""
    from datetime import date, timedelta
    d = date.fromisoformat(TODAY) + timedelta(days=offset_days)
    return d.isoformat()

def _iso_ts(offset_days: float) -> str:
    from datetime import datetime, timedelta, timezone
    base = datetime.fromisoformat(f"{TODAY}T09:00:00+00:00")
    ts = base + timedelta(days=offset_days)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# --------------------------------------------------------------------------
# Trainees
# --------------------------------------------------------------------------
# The signed-in user is the "primary" trainee (owner of the exception rows
# the spec will withdraw). Two additional trainees exist so wellbeing /
# retention tables have more than one row, which is closer to the shape a
# real admin view renders.

TRAINEE_PRIMARY_ID = FAKE_USER_ID
TRAINEE_SECONDARY_ID = "00000000-0000-0000-0000-000000000a01"
TRAINEE_TERTIARY_ID = "00000000-0000-0000-0000-000000000a02"

PROFILES: list[dict[str, Any]] = [
    {
        "id": TRAINEE_PRIMARY_ID,
        "full_name": "E2E Signed-in User",
        "email": FAKE_EMAIL,
        "grade": "ST5",
        "active": True,
    },
    {
        "id": TRAINEE_SECONDARY_ID,
        "full_name": "Test Trainee Two",
        "email": "trainee2@example.test",
        "grade": "ST4",
        "active": True,
    },
    {
        "id": TRAINEE_TERTIARY_ID,
        "full_name": "Test Trainee Three",
        "email": "trainee3@example.test",
        "grade": "ST6",
        "active": True,
    },
]

# --------------------------------------------------------------------------
# Exception reports
# --------------------------------------------------------------------------
# Named constants so a spec can reference "the hours exception the primary
# trainee withdraws" without indexing into a list. Each row is complete
# w.r.t. the ExceptionReport type in src/features/exceptions/types.ts so
# ExceptionCard renders without hitting `undefined`.

EX_HOURS_OPEN = "10000000-0000-0000-0000-000000000001"   # <- withdrawn by spec
EX_REST_RESOLVED = "10000000-0000-0000-0000-000000000002"
EX_SAFETY_OVERDUE = "10000000-0000-0000-0000-000000000003"
EX_OTHER_TRAINEE = "10000000-0000-0000-0000-0000000000ff"


def _exception(
    *,
    id: str,
    trainee_id: str,
    category: str,
    status: str,
    event_days_ago: int,
    due_in_days: float,
    outcome: str | None = None,
    resolved: bool = False,
    immediate_safety: bool = False,
) -> dict[str, Any]:
    created = _iso_ts(-event_days_ago)
    return {
        "id": id,
        "trainee_id": trainee_id,
        "event_date": _iso(-event_days_ago),
        "event_session": "am",
        "category": category,
        "immediate_safety_concern": immediate_safety,
        "description": f"Deterministic fixture exception: {category}",
        "hours_worked_extra": 2 if category == "hours" else None,
        "rest_missed_hours": 3 if category == "rest" else None,
        "status": status,
        "outcome": outcome,
        "outcome_note": None,
        "responder_id": None,
        "acknowledged_at": None,
        "resolved_at": _iso_ts(-event_days_ago + 1) if resolved else None,
        "due_by": _iso_ts(due_in_days),
        "created_at": created,
        "updated_at": created,
    }


EXCEPTION_REPORTS: list[dict[str, Any]] = [
    # Primary trainee — open, in-SLA hours exception. This is the row a
    # spec will click "Withdraw" on.
    _exception(
        id=EX_HOURS_OPEN,
        trainee_id=TRAINEE_PRIMARY_ID,
        category="hours",
        status="submitted",
        event_days_ago=2,
        due_in_days=5,
    ),
    # Primary trainee — already resolved. Counts toward "Resolved (all
    # time)" but never toward Open, so withdrawing EX_HOURS_OPEN must not
    # change this row's contribution to the totals.
    _exception(
        id=EX_REST_RESOLVED,
        trainee_id=TRAINEE_PRIMARY_ID,
        category="rest",
        status="resolved",
        event_days_ago=30,
        due_in_days=-23,
        outcome="toil",
        resolved=True,
    ),
    # Primary trainee — open AND overdue safety concern. Locks in that
    # withdrawing EX_HOURS_OPEN drops "Open" and "Overdue response" by
    # exactly one each, without collapsing them both to zero.
    _exception(
        id=EX_SAFETY_OVERDUE,
        trainee_id=TRAINEE_PRIMARY_ID,
        category="patient_safety",
        status="submitted",
        event_days_ago=3,
        due_in_days=-1,
        immediate_safety=True,
    ),
    # Different trainee — must not appear on the primary trainee's page.
    _exception(
        id=EX_OTHER_TRAINEE,
        trainee_id=TRAINEE_SECONDARY_ID,
        category="education",
        status="submitted",
        event_days_ago=1,
        due_in_days=6,
    ),
]


def exception_reports_for(trainee_id: str) -> list[dict[str, Any]]:
    """Rows the PostgREST `.eq('trainee_id', ...)` filter would return."""
    return [r for r in EXCEPTION_REPORTS if r["trainee_id"] == trainee_id]


def exception_reports_after_withdraw(
    withdrawn_id: str,
    *,
    trainee_id: str = TRAINEE_PRIMARY_ID,
) -> list[dict[str, Any]]:
    """
    Return a fresh copy of that trainee's rows with `withdrawn_id` flipped
    to `status = 'withdrawn'`. Never mutates the module-level fixture.
    """
    out: list[dict[str, Any]] = []
    for row in exception_reports_for(trainee_id):
        if row["id"] == withdrawn_id:
            out.append({**row, "status": "withdrawn"})
        else:
            out.append({**row})
    return out


# --------------------------------------------------------------------------
# Expected exception stats — mirrors src/routes/_authenticated/exceptions.tsx
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class ExceptionStats:
    open: int
    resolved: int
    overdue: int


def expected_exception_stats(
    rows: list[dict[str, Any]],
    *,
    now_iso: str = NOW_ISO,
) -> ExceptionStats:
    """Same arithmetic as the exceptions page. Safe against fixture edits."""
    from datetime import datetime
    now_ms = datetime.fromisoformat(now_iso.replace("Z", "+00:00")).timestamp() * 1000
    closed = {"resolved", "withdrawn"}
    open_rows = [r for r in rows if r["status"] not in closed]
    resolved_rows = [r for r in rows if r["status"] == "resolved"]
    overdue = sum(
        1
        for r in open_rows
        if datetime.fromisoformat(r["due_by"].replace("Z", "+00:00")).timestamp() * 1000
        < now_ms
    )
    return ExceptionStats(
        open=len(open_rows),
        resolved=len(resolved_rows),
        overdue=overdue,
    )


# --------------------------------------------------------------------------
# Wellbeing rows
# --------------------------------------------------------------------------
# These are the shape the admin wellbeing / retention view expects: one
# row per trainee with a computed score and drivers. The score for the
# primary trainee is deliberately in the "amber" band so a withdraw
# improving it (or the page invalidating and refetching) is visually
# obvious in a screenshot.

WELLBEING_ROWS: list[dict[str, Any]] = [
    {
        "staff_id": TRAINEE_PRIMARY_ID,
        "full_name": "E2E Signed-in User",
        "grade": "ST5",
        "score": 62,
        "band": "amber",
        "open_exceptions": 2,
        "overdue_exceptions": 1,
        "bradford_factor": 8,
        "updated_at": NOW_ISO,
    },
    {
        "staff_id": TRAINEE_SECONDARY_ID,
        "full_name": "Test Trainee Two",
        "grade": "ST4",
        "score": 81,
        "band": "green",
        "open_exceptions": 1,
        "overdue_exceptions": 0,
        "bradford_factor": 4,
        "updated_at": NOW_ISO,
    },
    {
        "staff_id": TRAINEE_TERTIARY_ID,
        "full_name": "Test Trainee Three",
        "grade": "ST6",
        "score": 74,
        "band": "green",
        "open_exceptions": 0,
        "overdue_exceptions": 0,
        "bradford_factor": 0,
        "updated_at": NOW_ISO,
    },
]


def wellbeing_rows_after_withdraw(
    withdrawn_id: str,
    *,
    trainee_id: str = TRAINEE_PRIMARY_ID,
) -> list[dict[str, Any]]:
    """
    Return the wellbeing rows the admin view would see AFTER the exception
    withdraw has been applied and wellbeing has been recomputed. The
    primary trainee's open/overdue counts drop, and the score moves up
    into the "green" band — matching the direction (though not the exact
    magnitude) of `computeWellbeing` in the app.
    """
    remaining = [
        r
        for r in exception_reports_after_withdraw(withdrawn_id, trainee_id=trainee_id)
        if r["status"] not in {"resolved", "withdrawn"}
    ]
    open_count = len(remaining)
    from datetime import datetime
    now_ms = datetime.fromisoformat(NOW_ISO.replace("Z", "+00:00")).timestamp() * 1000
    overdue_count = sum(
        1
        for r in remaining
        if datetime.fromisoformat(r["due_by"].replace("Z", "+00:00")).timestamp() * 1000
        < now_ms
    )
    out: list[dict[str, Any]] = []
    for row in WELLBEING_ROWS:
        if row["staff_id"] != trainee_id:
            out.append({**row})
            continue
        # Two open + one overdue = amber; one open + one overdue is still
        # amber; zero open = green. This is the direction assertion the
        # spec relies on.
        score = 62 + 12 * (row["open_exceptions"] - open_count)
        band = "green" if open_count == 0 and overdue_count == 0 else "amber"
        out.append(
            {
                **row,
                "open_exceptions": open_count,
                "overdue_exceptions": overdue_count,
                "score": score,
                "band": band,
            }
        )
    return out


# --------------------------------------------------------------------------
# Convenience bundle for `signed_in_context(rest_tables=...)`
# --------------------------------------------------------------------------

def rest_tables_before() -> dict[str, list[dict[str, Any]]]:
    return {
        "profiles": [dict(p) for p in PROFILES],
        "exception_reports": exception_reports_for(TRAINEE_PRIMARY_ID),
        "wellbeing_rows": [dict(r) for r in WELLBEING_ROWS],
    }


def rest_tables_after_withdraw(
    withdrawn_id: str = EX_HOURS_OPEN,
) -> dict[str, list[dict[str, Any]]]:
    return {
        "profiles": [dict(p) for p in PROFILES],
        "exception_reports": exception_reports_after_withdraw(withdrawn_id),
        "wellbeing_rows": wellbeing_rows_after_withdraw(withdrawn_id),
    }
