import { describe, expect, it } from "vitest";
import { computeTraineeMetrics, type MetricAssignment } from "./trainee-metrics";

/**
 * Regression: senior trainee (not in JUNIOR_TRAINEE_LEVELS) marked "solo" on
 * a theatre session that ALSO has a consultant/SAS doctor rostered should be
 * counted as supervised — the import defaults role_on_list to "solo" when it
 * can't pin a supervisor on the row. The /trainees detail page already does
 * this; the overview + admin dashboard must agree.
 */
describe("computeTraineeMetrics — supervisor-on-same-session reclassification", () => {
  const specSession = new Map<string, string | null>();
  const specNames = new Map<string, string>();

  const baseAssignment = (
    overrides: Partial<MetricAssignment> = {},
  ): MetricAssignment => ({
    role_on_list: "solo",
    session: "am",
    duty_type: "theatre",
    theatre_session_id: "ts-1",
    session_date: "2025-06-02",
    ...overrides,
  });

  it("treats senior 'solo' rows on supervised sessions as supervised", () => {
    const assignments = [
      baseAssignment({ theatre_session_id: "ts-with-consultant" }),
      baseAssignment({ theatre_session_id: "ts-genuinely-alone", session_date: "2025-06-03" }),
    ];
    const supervisorSessionIds = new Set<string>(["ts-with-consultant"]);

    const m = computeTraineeMetrics(
      assignments,
      "2025-01-01",
      specSession,
      specNames,
      new Date("2025-06-10").getTime(),
      null,
      false,
      false, // senior — not junior
      supervisorSessionIds,
    );

    expect(m.soloLists).toBe(1);
    expect(m.supervisedLists).toBe(1);
    expect(m.soloDaytimeLists).toBe(1);
  });

  it("leaves senior counts unchanged when no supervisor set is supplied", () => {
    const assignments = [
      baseAssignment({ theatre_session_id: "ts-a" }),
      baseAssignment({ theatre_session_id: "ts-b", session_date: "2025-06-03" }),
    ];

    const m = computeTraineeMetrics(
      assignments,
      "2025-01-01",
      specSession,
      specNames,
      new Date("2025-06-10").getTime(),
      null,
      false,
      false,
    );

    expect(m.soloLists).toBe(2);
    expect(m.supervisedLists).toBe(0);
  });

  it("junior flag still wins even without a supervisor set", () => {
    const assignments = [baseAssignment()];
    const m = computeTraineeMetrics(
      assignments,
      "2025-01-01",
      specSession,
      specNames,
      new Date("2025-06-10").getTime(),
      null,
      false,
      true, // junior
      null,
    );
    expect(m.soloLists).toBe(0);
    expect(m.supervisedLists).toBe(1);
  });
});
