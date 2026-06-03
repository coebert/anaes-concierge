import { describe, it, expect } from "vitest";
import {
  computeSoloCorrections,
  isSupervisorCapableGrade,
  type InvestigateAssignment,
  type InvestigateProfile,
  type InvestigateTheatreSession,
  type SoloCorrection,
} from "./solo-investigate";

/* ---------- shared fixtures ---------- */

const profiles = new Map<string, InvestigateProfile>([
  ["cons-1", { id: "cons-1", grade: "consultant", full_name: "Dr Consultant One" }],
  ["cons-2", { id: "cons-2", grade: "consultant", full_name: "Dr Consultant Two" }],
  ["sas-1", { id: "sas-1", grade: "sas", full_name: "Dr SAS One" }],
  ["train-1", { id: "train-1", grade: "trainee", full_name: "Dr Trainee One" }],
  ["train-2", { id: "train-2", grade: "trainee", full_name: "Dr Trainee Two" }],
  ["other-1", { id: "other-1", grade: "anp", full_name: "Nurse One" }],
]);

const base = {
  session_date: "2026-06-01",
  session: "am",
  role_on_list: "solo",
  duty_type: "theatre",
  locally_modified: false,
} as const;

function a(
  id: string,
  staff_id: string,
  theatre_session_id: string | null,
  overrides: Partial<InvestigateAssignment> = {},
): InvestigateAssignment {
  return { id, staff_id, theatre_session_id, ...base, ...overrides };
}

/* ---------- unit: helper ---------- */

describe("isSupervisorCapableGrade", () => {
  it("treats consultant and sas as supervisor-capable", () => {
    expect(isSupervisorCapableGrade("consultant")).toBe(true);
    expect(isSupervisorCapableGrade("sas")).toBe(true);
  });
  it("treats other / missing grades as not supervisor-capable", () => {
    expect(isSupervisorCapableGrade("trainee")).toBe(false);
    expect(isSupervisorCapableGrade("anp")).toBe(false);
    expect(isSupervisorCapableGrade(null)).toBe(false);
    expect(isSupervisorCapableGrade(undefined)).toBe(false);
  });
});

/* ---------- unit: category 1 (consultant/SAS on same session) ---------- */

describe("computeSoloCorrections — category 1: consultant/SAS on same session", () => {
  it("flags a trainee solo when a consultant is on the same theatre_session", () => {
    const assignments = [
      a("a1", "cons-1", "ts-1"),
      a("a2", "train-1", "ts-1"),
    ];
    const out = computeSoloCorrections({
      assignments,
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.assignment_id).toBe("a2");
    expect(c.category).toBe("consultant_or_sas_on_session");
    expect(c.proposed_supervisor_id).toBe("cons-1");
    expect(c.auto_applicable).toBe(true);
    expect(c.staff_name).toBe("Dr Trainee One");
  });

  it("sets proposed_supervisor_id to null when two supervisors are on the same session", () => {
    const out = computeSoloCorrections({
      assignments: [
        a("a1", "cons-1", "ts-1"),
        a("a2", "cons-2", "ts-1"),
        a("a3", "train-1", "ts-1"),
      ],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].proposed_supervisor_id).toBeNull();
    expect(out[0].auto_applicable).toBe(true);
  });

  it("flags a trainee solo when only an SAS doctor is on the same session", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "sas-1", "ts-1"), a("a2", "train-1", "ts-1")],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].proposed_supervisor_id).toBe("sas-1");
    expect(out[0].reason).toMatch(/sas/);
  });

  it("does NOT flag when no consultant/SAS shares the session", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", "ts-1"), a("a2", "other-1", "ts-1")],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(0);
  });

  it("does NOT flag a non-trainee solo even if a consultant is on the session", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "cons-1", "ts-1"), a("a2", "other-1", "ts-1")],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(0);
  });

  it("does NOT flag locally_modified rows (manual override is sacred)", () => {
    const out = computeSoloCorrections({
      assignments: [
        a("a1", "cons-1", "ts-1"),
        a("a2", "train-1", "ts-1", { locally_modified: true }),
      ],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(0);
  });

  it("does NOT flag rows whose role_on_list is not 'solo'", () => {
    const out = computeSoloCorrections({
      assignments: [
        a("a1", "cons-1", "ts-1"),
        a("a2", "train-1", "ts-1", { role_on_list: "supervised" }),
      ],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(0);
  });
});

/* ---------- unit: category 2 (unmatched theatre solo) ---------- */

describe("computeSoloCorrections — category 2: unmatched_theatre_solo", () => {
  it("flags a trainee theatre row with no theatre_session_id, review-only", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", null, { duty_type: "theatre" })],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("unmatched_theatre_solo");
    expect(out[0].auto_applicable).toBe(false);
    expect(out[0].proposed_supervisor_id).toBeUndefined();
  });

  it("does NOT flag non-theatre duties (admin, leave, etc.) with no session id", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", null, { duty_type: "admin_session" })],
      profilesById: profiles,
      theatreSessionsById: new Map(),
    });
    expect(out).toHaveLength(0);
  });
});

/* ---------- unit: category 3 (non-training label) ---------- */

describe("computeSoloCorrections — category 3: non_training_label", () => {
  const ts = new Map<string, InvestigateTheatreSession>([
    [
      "ts-off",
      { id: "ts-off", specialty_name: "Off Day", surgical_consultant: null, notes: null },
    ],
    [
      "ts-avail",
      { id: "ts-avail", specialty_name: null, surgical_consultant: "Available", notes: null },
    ],
    [
      "ts-real",
      { id: "ts-real", specialty_name: "Orthopaedics", surgical_consultant: "Mr Bone", notes: null },
    ],
    [
      "ts-custom",
      { id: "ts-custom", specialty_name: "Teaching", surgical_consultant: null, notes: null },
    ],
  ]);

  it("flags a solo trainee on a session whose specialty looks like 'Off Day'", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", "ts-off")],
      profilesById: profiles,
      theatreSessionsById: ts,
    });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("non_training_label");
    expect(out[0].auto_applicable).toBe(false);
  });

  it("flags a solo trainee on a session marked 'Available' in surgical_consultant", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", "ts-avail")],
      profilesById: profiles,
      theatreSessionsById: ts,
    });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("non_training_label");
  });

  it("respects extraNonWorkingTokens configured by coordinators", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", "ts-custom")],
      profilesById: profiles,
      theatreSessionsById: ts,
      extraNonWorkingTokens: ["teaching"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("non_training_label");
  });

  it("does NOT flag a real clinical session label", () => {
    const out = computeSoloCorrections({
      assignments: [a("a1", "train-1", "ts-real")],
      profilesById: profiles,
      theatreSessionsById: ts,
    });
    expect(out).toHaveLength(0);
  });

  it("non_training_label takes precedence over consultant-on-session", () => {
    // Even if a consultant is also on the off-day placeholder row, the
    // label is the dominant signal — the row should not be auto-converted.
    const out = computeSoloCorrections({
      assignments: [
        a("a1", "cons-1", "ts-off"),
        a("a2", "train-1", "ts-off"),
      ],
      profilesById: profiles,
      theatreSessionsById: ts,
    });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("non_training_label");
    expect(out[0].auto_applicable).toBe(false);
  });
});

/* ---------- integration: mixed batches end-to-end ---------- */

describe("computeSoloCorrections — integration: mixed realistic batch", () => {
  const ts = new Map<string, InvestigateTheatreSession>([
    ["ts-ortho-am", { id: "ts-ortho-am", specialty_name: "Orthopaedics" }],
    ["ts-gen-pm", { id: "ts-gen-pm", specialty_name: "General Surgery" }],
    ["ts-off", { id: "ts-off", specialty_name: "Off Day" }],
    ["ts-ent", { id: "ts-ent", specialty_name: "ENT" }],
  ]);

  const assignments: InvestigateAssignment[] = [
    // 1) consultant + trainee on ortho AM — should auto-correct
    a("ax1", "cons-1", "ts-ortho-am", { session: "am" }),
    a("ax2", "train-1", "ts-ortho-am", { session: "am" }),
    // 2) sas + trainee on general PM — should auto-correct, supervisor=sas-1
    a("ax3", "sas-1", "ts-gen-pm", { session: "pm" }),
    a("ax4", "train-2", "ts-gen-pm", { session: "pm" }),
    // 3) trainee solo, no session id — unmatched_theatre_solo
    a("ax5", "train-1", null, { session: "am", session_date: "2026-06-02" }),
    // 4) trainee solo on Off Day label — non_training_label
    a("ax6", "train-2", "ts-off", { session: "am", session_date: "2026-06-03" }),
    // 5) trainee solo on a real ENT list with no supervisor — legitimate, no flag
    a("ax7", "train-1", "ts-ent", { session: "pm", session_date: "2026-06-04" }),
    // 6) trainee supervised already — never flagged
    a("ax8", "train-2", "ts-ent", { role_on_list: "supervised" }),
    // 7) locally_modified solo trainee with consultant on same session — never flagged
    a("ax9", "cons-2", "ts-ortho-am", { session_date: "2026-06-05" }),
    a(
      "ax10",
      "train-1",
      "ts-ortho-am",
      { session_date: "2026-06-05", locally_modified: true },
    ),
  ];

  const corrections = computeSoloCorrections({
    assignments,
    profilesById: profiles,
    theatreSessionsById: ts,
  });

  it("returns exactly the four expected corrections", () => {
    const summary = corrections
      .map((c) => `${c.assignment_id}:${c.category}`)
      .sort();
    expect(summary).toEqual([
      "ax2:consultant_or_sas_on_session",
      "ax4:consultant_or_sas_on_session",
      "ax5:unmatched_theatre_solo",
      "ax6:non_training_label",
    ]);
  });

  it("marks only category 1 as auto-applicable", () => {
    const auto = corrections.filter((c) => c.auto_applicable).map((c) => c.assignment_id);
    expect(auto.sort()).toEqual(["ax2", "ax4"]);
  });

  it("groups auto-applicable corrections by proposed supervisor (apply-path simulation)", () => {
    // Mirror the grouping logic used by the apply path in
    // investigateAndFixTraineeSolo to confirm corrections can be batched
    // into update statements without losing supervisor attribution.
    const auto = corrections.filter(
      (c): c is SoloCorrection & { auto_applicable: true } => c.auto_applicable,
    );
    const groups = new Map<string, string[]>();
    for (const c of auto) {
      const key = c.proposed_supervisor_id ?? "__none__";
      const list = groups.get(key) ?? [];
      list.push(c.assignment_id);
      groups.set(key, list);
    }
    // ax2 is on ts-ortho-am which has BOTH cons-1 and cons-2 across the
    // batch (ax1 + ax9), so proposed_supervisor_id is null -> "__none__".
    expect(groups.get("__none__")).toEqual(["ax2"]);
    // ax4 has only sas-1 on its session, so supervisor is unambiguous.
    expect(groups.get("sas-1")).toEqual(["ax4"]);
  });

  it("never flags locally_modified rows even in a mixed batch", () => {
    expect(corrections.find((c) => c.assignment_id === "ax10")).toBeUndefined();
  });

  it("never flags rows that are already supervised", () => {
    expect(corrections.find((c) => c.assignment_id === "ax8")).toBeUndefined();
  });
});
