// CLWRota feature barrel — the public API surface for the clwrota feature
// folder. Physically split (Phase 4a.ii) into focused submodules:
//
//   settings.functions.ts — settings CRUD + shared `getEnv`
//   status.functions.ts   — reclassification runs, investigation, metrics,
//                           Non-SAG backfill
//   sync.functions.ts     — staff + rota sync, orchestrator
//   leave.functions.ts    — leave sync
//   parsing.ts            — pure URL/window/parse/normalise/classify helpers
//   parsing.server.ts     — admin-scoped mapping-table loaders
//
// Consumers should keep importing from this file (or the folder root) —
// each submodule owns its own concern.
export {
  getEnv,
  testClwRotaConnection,
  getClwRotaSettings,
  saveClwRotaSettings,
} from "./settings.functions";

export {
  listReclassificationRuns,
  undoReclassificationRun,
  investigateAndFixTraineeSolo,
  listClwRotaSyncMetrics,
  backfillNonSagLabels,
} from "./status.functions";

export {
  syncClwRotaStaff,
  performStaffSync,
  runClwRotaSync,
  syncClwRotaRota,
  performRotaSync,
  performRotaSyncChunked,
  performRotaSyncIncremental,
} from "./sync.functions";

export {
  syncClwRotaLeave,
  performLeaveSync,
} from "./leave.functions";

export {
  getClwRotaSyncStatus,
  type ClwRotaStatusState,
  type ClwRotaMetricRow,
  type ClwRotaCronRow,
  type ClwRotaStatusResponse,
} from "./sync-status.functions";

export {
  getClwRotaStepStatus,
  runClwRotaStepRateLimited,
  type SyncStep,
  type StepMetric,
  type StepRateLimit,
  type StepStatus,
  type RateLimiterRun,
  type ClwRotaStepStatusResponse,
  type RunStepResult,
} from "./step-status.functions";

export {
  withRollingFutureWindow,
  ensureLeaveReportFields,
  clampDateWindow,
  explicitDateWindow,
  normaliseSession,
  normaliseDate,
  normaliseRole,
  normaliseClassifierText,
  classifyDutyType,
  resolveOffsiteTheatreAlias,
  type SessionHalf,
  type ResolvedDutyType,
  type DutyTypeMappingRow,
} from "./parsing";
