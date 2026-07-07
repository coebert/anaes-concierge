// Pure TS leave fairness engine — computes per-staff metrics used by the
// admin fairness dashboard.
// - denial rate over a rolling 12-month window
// - share of approved leave falling on "prime" dates (bank holidays + Xmas/NY window)
// - SLA compliance (created → decided hours) vs the allowance target
// - denial-reason taxonomy

import type { LeaveRow, LeaveStatus } from "@/features/leave/entitlement-ledger";
import { leaveDayCount } from "@/features/leave/entitlement-ledger";

const DAY_MS = 86_400_000;

/** UK bank holidays 2024–2027 (England & Wales). */
export const UK_BANK_HOLIDAYS: string[] = [
  // 2024
  "2024-01-01", "2024-03-29", "2024-04-01", "2024-05-06", "2024-05-27",
  "2024-08-26", "2024-12-25", "2024-12-26",
  // 2025
  "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26",
  "2025-08-25", "2025-12-25", "2025-12-26",
  // 2026
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25",
  "2026-08-31", "2026-12-25", "2026-12-28",
  // 2027
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
  "2027-08-30", "2027-12-27", "2027-12-28",
];
const BH_SET = new Set(UK_BANK_HOLIDAYS);

function isPrimeDate(iso: string): boolean {
  if (BH_SET.has(iso)) return true;
  const md = iso.slice(5); // MM-DD
  // Christmas / New Year window
  if (md >= "12-20" && md <= "12-31") return true;
  if (md >= "01-01" && md <= "01-02") return true;
  return false;
}

function eachDay(startISO: string, endISO: string): string[] {
  const s = new Date(startISO + "T00:00:00Z").getTime();
  const e = new Date(endISO + "T00:00:00Z").getTime();
  const out: string[] = [];
  for (let t = s; t <= e; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export interface FairnessMetrics {
  approvedCount: number;
  deniedCount: number;
  pendingCount: number;
  denialRate: number; // 0..1
  totalApprovedDays: number;
  primeDateDays: number;
  primeDateShare: number; // 0..1
  medianDecisionHours: number | null;
  slaBreachCount: number; // decisions later than sla_target_days OR pending past it
  denialReasons: Record<string, number>;
  slaTargetDays: number;
}

export interface FairnessInput {
  rows: LeaveRow[]; // all leave rows for this staff
  slaTargetDays: number;
  now?: Date;
  windowDays?: number; // default 365
  decisionNotes?: Record<string, string | null>; // by leave id
}

function classifyReason(text: string | null | undefined): string {
  if (!text) return "unspecified";
  const t = text.toLowerCase();
  if (/rota|cover|staffing|short/.test(t)) return "rota pressure";
  if (/conflict|clash|overlap/.test(t)) return "conflict with other leave";
  if (/notice|late|deadline/.test(t)) return "insufficient notice";
  if (/quota|allowance|budget|limit/.test(t)) return "quota exceeded";
  if (/list|theatre|cepod|on.?call/.test(t)) return "list/on-call impact";
  return "other";
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeFairnessMetrics(input: FairnessInput): FairnessMetrics {
  const now = input.now ?? new Date();
  const windowStart = now.getTime() - (input.windowDays ?? 365) * DAY_MS;

  const inWindow = input.rows.filter((r) => {
    const t = new Date(r.start_date + "T00:00:00Z").getTime();
    return t >= windowStart && r.type !== "sick"; // sick handled by Bradford
  });

  const approved = inWindow.filter((r) => r.status === "approved");
  const denied = inWindow.filter((r) => r.status === ("denied" as LeaveStatus));
  const pending = inWindow.filter((r) => r.status === "pending");

  let approvedDays = 0;
  let primeDays = 0;
  for (const r of approved) {
    const total = leaveDayCount(r);
    approvedDays += total;
    const days = eachDay(r.start_date, r.end_date);
    const primeShare = days.filter(isPrimeDate).length / Math.max(1, days.length);
    primeDays += total * primeShare;
  }

  const denialReasons: Record<string, number> = {};
  for (const r of denied) {
    const bucket = classifyReason(input.decisionNotes?.[r.id]);
    denialReasons[bucket] = (denialReasons[bucket] ?? 0) + 1;
  }

  const decisionHours = inWindow
    .filter((r) => r.created_at && r.decided_at)
    .map((r) => {
      const c = new Date(r.created_at as string).getTime();
      const d = new Date(r.decided_at as string).getTime();
      return (d - c) / 3_600_000;
    });
  const medDecision = median(decisionHours);

  const slaHours = input.slaTargetDays * 24;
  let breaches = decisionHours.filter((h) => h > slaHours).length;
  breaches += pending.filter((r) => {
    if (!r.created_at) return false;
    return (now.getTime() - new Date(r.created_at).getTime()) / 3_600_000 > slaHours;
  }).length;

  const totalDecisions = approved.length + denied.length;
  return {
    approvedCount: approved.length,
    deniedCount: denied.length,
    pendingCount: pending.length,
    denialRate: totalDecisions > 0 ? denied.length / totalDecisions : 0,
    totalApprovedDays: Math.round(approvedDays * 100) / 100,
    primeDateDays: Math.round(primeDays * 100) / 100,
    primeDateShare: approvedDays > 0 ? Math.round((primeDays / approvedDays) * 1000) / 1000 : 0,
    medianDecisionHours: medDecision === null ? null : Math.round(medDecision * 10) / 10,
    slaBreachCount: breaches,
    denialReasons,
    slaTargetDays: input.slaTargetDays,
  };
}

/** Gini coefficient across an array of non-negative values. */
export function gini(values: number[]): number {
  const xs = values.filter((v) => v >= 0);
  if (xs.length === 0) return 0;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}
