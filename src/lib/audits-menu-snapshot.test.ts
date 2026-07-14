import { describe, it, expect } from "vitest";
import { NAV_ITEMS } from "./navigation";

/**
 * Snapshot guard for the "Audits & robustness" menu group.
 *
 * After moving Absence (Bradford), Leave fairness, and Wellbeing & attrition
 * to the Staff group, we lock the exact contents of the audits group so any
 * future re-introduction of these three items (by ID, label, or route) fails
 * loudly in CI. The forbidden list is asserted explicitly in addition to the
 * snapshot so a bulk snapshot update cannot silently re-add them.
 */
describe("audits/robustness menu snapshot", () => {
  const FORBIDDEN_IDS = ["absence", "leave-fairness", "wellbeing-admin"] as const;
  const FORBIDDEN_ROUTES = [
    "/admin/absence",
    "/admin/leave-fairness",
    "/admin/wellbeing",
  ] as const;
  const FORBIDDEN_LABELS = [
    "Absence (Bradford)",
    "Leave fairness",
    "Wellbeing & attrition",
  ] as const;

  const auditItems = NAV_ITEMS.filter((i) => i.group === "audits");

  it("does not contain any of the three moved items (by id, route, or label)", () => {
    const offending = auditItems.filter(
      (i) =>
        (FORBIDDEN_IDS as readonly string[]).includes(i.id) ||
        (FORBIDDEN_ROUTES as readonly string[]).includes(i.to) ||
        (FORBIDDEN_LABELS as readonly string[]).includes(i.label),
    );
    expect(
      offending,
      `Forbidden items resurfaced under audits: ${offending
        .map((i) => `${i.id} (${i.to})`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("matches the locked snapshot of audits group members", () => {
    // Ordered {id, label, to} triples — order matches declaration order in
    // NAV_ITEMS so it doubles as a stable menu-ordering check.
    const shape = auditItems.map((i) => ({ id: i.id, label: i.label, to: i.to }));
    expect(shape).toMatchInlineSnapshot(`
      [
        {
          "id": "audit-ai",
          "label": "AI audit assistant",
          "to": "/admin/audit-tool",
        },
        {
          "id": "consultant-audits",
          "label": "Consultant audits",
          "to": "/robustness/consultant-audits",
        },
        {
          "id": "robustness-consultant",
          "label": "Consultant feasibility",
          "to": "/robustness/consultant-feasibility",
        },
        {
          "id": "exceptions-admin",
          "label": "Exception reports (Guardian)",
          "to": "/admin/exceptions",
        },
        {
          "id": "hr-analytics",
          "label": "HR analytics pack",
          "to": "/admin/analytics",
        },
        {
          "id": "last-minute-changes",
          "label": "Last minute changes audit",
          "to": "/robustness/last-minute-changes",
        },
        {
          "id": "robustness-list",
          "label": "List feasibility",
          "to": "/robustness/list-feasibility",
        },
        {
          "id": "exceptions-mine",
          "label": "My exception reports",
          "to": "/exceptions",
        },
        {
          "id": "poac-audit",
          "label": "POAC audit",
          "to": "/robustness/poac-audit",
        },
        {
          "id": "pulse-admin",
          "label": "Pulse surveys",
          "to": "/admin/pulse",
        },
        {
          "id": "robustness",
          "label": "Robustness overview",
          "to": "/robustness",
        },
        {
          "id": "audit-data",
          "label": "Rota source data",
          "to": "/admin/dashboard",
        },
        {
          "id": "robustness-simulate",
          "label": "Simulator",
          "to": "/robustness/simulate",
        },
        {
          "id": "tcs",
          "label": "TCS 2016 audit",
          "to": "/admin/tcs-audit",
        },
        {
          "id": "trainees",
          "label": "Trainee audit",
          "to": "/trainees",
        },
        {
          "id": "weekend-workload",
          "label": "Weekend workload (job plan)",
          "to": "/admin/analytics/weekend-workload",
        },
      ]
    `);
  });
});
