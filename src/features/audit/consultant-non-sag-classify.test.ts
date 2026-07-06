import { describe, it, expect } from "vitest";
import {
  classifyConsultantAssignment,
  type SagMark,
} from "./consultant-non-sag-classify";

/**
 * Integration-level tests for the consultant-audits non-SAG counter.
 *
 * Covers the two CLWRota row shapes that previously slipped through the
 * audit before the per-assignment `is_non_sag` flag was added:
 *
 *   1) NHH non-SAG lists that arrive in CLWRota with no recognisable
 *      theatre (theatre_session_id is null on the assignment). Before
 *      the flag, the counter saw `duty_type='theatre'` + null session
 *      and skipped the row entirely.
 *   2) Non-SAG on-call cover (`duty_type='on_call'`, theatre_session_id
 *      null). Before the flag there was no way to distinguish these
 *      from regular SAG on-call.
 *
 * If these tests fail, either the route's counting logic has drifted
 * away from the shared classifier or the assignment-level fallback has
 * regressed and theatre-less / on-call non-SAG rows are no longer
 * counted in the per-consultant audit.
 */

const nhh = (reviewed = false): SagMark => ({ kind: "non_sag", reviewed });
const sag = (): SagMark => ({ kind: "sag", reviewed: false });

describe("classifyConsultantAssignment", () => {
  it("counts a theatre-less NHH non-SAG list via the assignment flag", () => {
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: null, is_non_sag: true },
      new Map(),
    );
    expect(result).toEqual({ bucket: "non_sag", reviewed: false });
  });

  it("counts a non-SAG on-call cover via the assignment flag", () => {
    const result = classifyConsultantAssignment(
      { duty_type: "on_call", theatre_session_id: null, is_non_sag: true },
      new Map(),
    );
    expect(result).toEqual({ bucket: "non_sag", reviewed: false });
  });

  it("counts an NHH list whose theatre_session is flagged non-SAG", () => {
    const sessions = new Map<string, SagMark>([["sess-1", nhh(true)]]);
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: "sess-1", is_non_sag: false },
      sessions,
    );
    expect(result).toEqual({ bucket: "non_sag", reviewed: true });
  });

  it("counts a regular NHH theatre list as SAG", () => {
    const sessions = new Map<string, SagMark>([["sess-1", sag()]]);
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: "sess-1", is_non_sag: false },
      sessions,
    );
    expect(result).toEqual({ bucket: "sag", reviewed: false });
  });

  it("counts SPA duty as spa regardless of theatre", () => {
    const result = classifyConsultantAssignment(
      { duty_type: "spa", theatre_session_id: null, is_non_sag: false },
      new Map(),
    );
    expect(result.bucket).toBe("spa");
  });

  it("the assignment flag takes precedence over the session flag", () => {
    // Edge case: assignment is flagged non-SAG but its linked session is
    // a regular SAG list. Assignment-level flag wins, because the CLWRota
    // feed is the source of truth for the row itself. `reviewed` is
    // false because the session is not marked non-SAG.
    const sessions = new Map<string, SagMark>([["sess-1", sag()]]);
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: "sess-1", is_non_sag: true },
      sessions,
    );
    expect(result).toEqual({ bucket: "non_sag", reviewed: false });
  });

  it("ignores a non-theatre row with no assignment flag", () => {
    const result = classifyConsultantAssignment(
      { duty_type: "on_call", theatre_session_id: null, is_non_sag: false },
      new Map(),
    );
    expect(result.bucket).toBe("none");
  });

  it("ignores a theatre row at a non-NHH theatre (not in sagBySession)", () => {
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: "other", is_non_sag: false },
      new Map(),
    );
    expect(result.bucket).toBe("none");
  });

  it("ignores a theatre row with no session and no assignment flag", () => {
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: null, is_non_sag: false },
      new Map(),
    );
    expect(result.bucket).toBe("none");
  });

  it("preserves the reviewed flag on assignment-flagged non-SAG when session is also reviewed", () => {
    const sessions = new Map<string, SagMark>([["sess-1", nhh(true)]]);
    const result = classifyConsultantAssignment(
      { duty_type: "theatre", theatre_session_id: "sess-1", is_non_sag: true },
      sessions,
    );
    expect(result).toEqual({ bucket: "non_sag", reviewed: true });
  });
});

/**
 * End-to-end aggregation test: simulate a mixed batch of rota_assignments
 * rows for a single consultant and check that the per-consultant counters
 * line up with what the audit page would show. This mirrors the loop in
 * src/routes/_authenticated/robustness.consultant-audits.tsx.
 */
describe("consultant-audits aggregation — mixed CLWRota row shapes", () => {
  it("counts theatre-less and on-call non-SAG alongside session-linked rows", () => {
    const sagBySession = new Map<string, SagMark>([
      ["nhh-sag-1", sag()],
      ["nhh-sag-2", sag()],
      ["nhh-nonsag-reviewed", nhh(true)],
      ["nhh-nonsag-unreviewed", nhh(false)],
    ]);

    const assignments = [
      // 2 regular NHH SAG lists
      { duty_type: "theatre", theatre_session_id: "nhh-sag-1", is_non_sag: false },
      { duty_type: "theatre", theatre_session_id: "nhh-sag-2", is_non_sag: false },
      // 1 session-flagged non-SAG (admin reviewed)
      { duty_type: "theatre", theatre_session_id: "nhh-nonsag-reviewed", is_non_sag: false },
      // 1 session-flagged non-SAG (not reviewed)
      { duty_type: "theatre", theatre_session_id: "nhh-nonsag-unreviewed", is_non_sag: false },
      // 1 theatre-less NHH non-SAG list (the new case)
      { duty_type: "theatre", theatre_session_id: null, is_non_sag: true },
      // 1 non-SAG on-call (the new case)
      { duty_type: "on_call", theatre_session_id: null, is_non_sag: true },
      // 3 SPA sessions
      { duty_type: "spa", theatre_session_id: null, is_non_sag: false },
      { duty_type: "spa", theatre_session_id: null, is_non_sag: false },
      { duty_type: "spa", theatre_session_id: null, is_non_sag: false },
      // Noise that must NOT be counted
      { duty_type: "on_call", theatre_session_id: null, is_non_sag: false },
      { duty_type: "admin", theatre_session_id: null, is_non_sag: false },
      { duty_type: "theatre", theatre_session_id: "unknown-theatre", is_non_sag: false },
    ];

    const c = { spa: 0, sag: 0, nonSag: 0, nonSagReviewed: 0 };
    for (const a of assignments) {
      const r = classifyConsultantAssignment(a, sagBySession);
      if (r.bucket === "spa") c.spa += 1;
      else if (r.bucket === "sag") c.sag += 1;
      else if (r.bucket === "non_sag") {
        c.nonSag += 1;
        if (r.reviewed) c.nonSagReviewed += 1;
      }
    }

    expect(c).toEqual({
      spa: 3,
      sag: 2,
      // 1 session-reviewed + 1 session-unreviewed + 1 theatre-less + 1 on-call
      nonSag: 4,
      // Only the session-reviewed row counts as admin-reviewed. The two
      // assignment-flagged rows have no linked session, so they cannot
      // carry a reviewed marker.
      nonSagReviewed: 1,
    });
  });
});
