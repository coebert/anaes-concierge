import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle } from "lucide-react";
import { Stat } from "@/routes/_authenticated/-admin-settings-stat";

// ---------- ValidateResultPanel ----------

type ValidateData = {
  window: { from: string; to: string };
  traineesScanned: number;
  traineesWithTheatreRows: number;
  fullyMatched: number;
  mismatches: Array<{
    staff_id: string;
    full_name?: string | null;
    matched: number;
    unmatched: number;
    unmatchedRatio: number;
    reason: string;
    likelyCause: string;
    likelyCauseExplanation: string;
    unmatchedWithOtherTheatreSessions: number;
  }>;
  onIcuBlock: Array<{
    staff_id: string;
    full_name?: string | null;
    unmatchedTheatreRows: number;
  }>;
};

export function ValidateResultPanel({
  data,
  retryAttempt,
  maxRetries,
  retriedTrainees,
  stalledCause,
  rotaPending,
  validatePending,
}: {
  data: ValidateData;
  retryAttempt: number;
  maxRetries: number;
  retriedTrainees: string[];
  stalledCause: string | null;
  rotaPending: boolean;
  validatePending: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-3 text-xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-sm flex items-center gap-2">
          Post-sync trainee theatre audit
          {retryAttempt > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {rotaPending || validatePending
                ? `Retry ${retryAttempt}/${maxRetries} in progress…`
                : `${retryAttempt}/${maxRetries} retries used`}
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground">
          Window {data.window.from} → {data.window.to}
        </div>
      </div>
      {retriedTrainees.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          Last targeted retry covered: {retriedTrainees.slice(0, 8).join(", ")}
          {retriedTrainees.length > 8 ? `, +${retriedTrainees.length - 8} more` : ""}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Trainees scanned" value={data.traineesScanned} />
        <Stat label="With theatre rows" value={data.traineesWithTheatreRows} />
        <Stat label="Fully matched" value={data.fullyMatched} tone="success" />
        <Stat
          label="Mismatches"
          value={data.mismatches.length}
          tone={data.mismatches.length ? "danger" : "success"}
        />
      </div>
      {data.mismatches.length === 0 ? (
        <div className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-success dark:bg-emerald-950/40 dark:text-emerald-400">
          <CheckCircle2 className="h-3 w-3" />
          All trainees with theatre rows have at least one matched list
          and an unmatched ratio below 50%.
        </div>
      ) : (
        <>
          {stalledCause && (
            <div className="flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
              <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <div>
                <div className="font-medium">Retry stopped — mismatch set unchanged.</div>
                <div>Likely root cause: {stalledCause}.</div>
              </div>
            </div>
          )}
          <details className="rounded border border-border p-2" open>
            <summary className="cursor-pointer font-medium">
              Trainees with unmatched theatre rows ({data.mismatches.length})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-2">Trainee</th>
                    <th className="py-1 pr-2">Matched</th>
                    <th className="py-1 pr-2">Unmatched</th>
                    <th className="py-1 pr-2">Unmatched %</th>
                    <th className="py-1 pr-2">Reason</th>
                    <th className="py-1 pr-2">Likely cause</th>
                  </tr>
                </thead>
                <tbody>
                  {data.mismatches.map((m) => (
                    <tr key={m.staff_id} className="border-t border-border/50 align-top">
                      <td className="py-1 pr-2">{m.full_name ?? m.staff_id}</td>
                      <td className="py-1 pr-2">{m.matched}</td>
                      <td className="py-1 pr-2">{m.unmatched}</td>
                      <td className="py-1 pr-2">{Math.round(m.unmatchedRatio * 100)}%</td>
                      <td className="py-1 pr-2">
                        {m.reason === "no_matches" ? "No matched lists" : "High unmatched ratio"}
                      </td>
                      <td className="py-1 pr-2" title={m.likelyCauseExplanation}>
                        {m.likelyCause === "theatre_name_alias_missing"
                          ? "Alias missing"
                          : m.likelyCause === "no_theatre_sessions_on_those_days"
                            ? "No theatre listing"
                            : m.likelyCause === "mixed"
                              ? "Mixed"
                              : "Unknown"}
                        {" "}
                        <span className="text-muted-foreground">
                          ({m.unmatchedWithOtherTheatreSessions}/{m.unmatched} on days with a theatre)
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {data.onIcuBlock.length > 0 && (
        <details className="rounded border border-sky-300/60 bg-sky-50/50 p-2 dark:border-sky-700/60 dark:bg-sky-950/30" open>
          <summary className="cursor-pointer font-medium text-sky-800 dark:text-sky-200">
            On ICU block — no theatre lists expected ({data.onIcuBlock.length})
          </summary>
          <p className="mt-1 text-[11px] text-muted-foreground">
            These trainees' remaining rotation is ICU-only, so unmatched
            theatre rows are not treated as warnings. They have been
            excluded from the mismatch list above.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {data.onIcuBlock.map((t) => (
              <li key={t.staff_id}>
                <Badge
                  variant="outline"
                  className="border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                  title={`${t.unmatchedTheatreRows} unmatched theatre row(s) in window — ignored because trainee is on ICU block.`}
                >
                  {t.full_name ?? t.staff_id}
                </Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------- BackfillNonSagResultPanel ----------

type BackfillData = {
  rowsScanned: number;
  rowsTagged: number;
  sessionsUpdated: number;
  sessionsSkippedOverride: number;
  unmatched: string[];
};

export function BackfillNonSagResultPanel({ data }: { data: BackfillData }) {
  return (
    <div className="rounded-md border border-border p-3 text-xs space-y-2">
      <div className="font-medium text-sm">Last Non-SAG backfill</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Rows scanned" value={data.rowsScanned} />
        <Stat label="Rows tagged" value={data.rowsTagged} tone="info" />
        <Stat label="Sessions updated" value={data.sessionsUpdated} tone="success" />
        <Stat label="Kept (override)" value={data.sessionsSkippedOverride} />
      </div>
      {data.unmatched.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Unmatched theatres ({data.unmatched.length})
          </summary>
          <div className="mt-2 text-muted-foreground">{data.unmatched.join(", ")}</div>
        </details>
      )}
    </div>
  );
}

// ---------- Shared sync-result panel for leave and rota ----------

type SyncCommon = {
  total: number;
  upserted?: number;
  assignmentsUpserted?: number;
  sessionsUpserted?: number;
  skipped: Array<{ label: string; reason: string }>;
  errors: Array<{ label: string; error: string }>;
  unmatchedStaff: string[];
  unmatchedTheatres?: string[];
  sampleKeys: string[];
  rawPreview?: string;
};

export function LeaveSyncResultPanel({ data }: { data: SyncCommon }) {
  return (
    <div className="rounded-md border border-border p-3 text-xs space-y-3">
      <div className="font-medium text-sm">Last leave sync results</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Rows pulled" value={data.total} />
        <Stat label="Upserted" value={data.upserted ?? 0} tone="success" />
        <Stat
          label="Skipped / errors"
          value={data.skipped.length + data.errors.length}
          tone={data.errors.length ? "danger" : undefined}
        />
      </div>
      {data.unmatchedStaff.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Unmatched staff ({data.unmatchedStaff.length})
          </summary>
          <div className="mt-2 break-all text-muted-foreground">
            {data.unmatchedStaff.join(", ")}
          </div>
        </details>
      )}
      {data.skipped.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Skipped rows ({data.skipped.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
            {data.skipped.slice(0, 200).map((s, i) => (
              <li key={i}>
                {s.label} — <span className="italic">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.errors.length > 0 && (
        <details open className="rounded border border-destructive/40 p-2">
          <summary className="cursor-pointer font-medium text-destructive">
            Errors ({data.errors.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-destructive">
            {data.errors.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.label}</span> — {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.sampleKeys.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Detected CLWRota columns ({data.sampleKeys.length})
          </summary>
          <div className="mt-2 break-all text-muted-foreground">{data.sampleKeys.join(", ")}</div>
        </details>
      )}
      {data.rawPreview && data.total === 0 && (
        <div>
          <div className="font-medium text-foreground">Response preview:</div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px]">
            {data.rawPreview}
          </pre>
        </div>
      )}
    </div>
  );
}

export function RotaSyncResultPanel({ data }: { data: SyncCommon }) {
  return (
    <div className="rounded-md border border-border p-3 text-xs space-y-3">
      <div className="font-medium text-sm">Last rota sync results</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Rows pulled" value={data.total} />
        <Stat label="Assignments" value={data.assignmentsUpserted ?? 0} tone="success" />
        <Stat label="New sessions" value={data.sessionsUpserted ?? 0} tone="info" />
        <Stat
          label="Skipped / errors"
          value={data.skipped.length + data.errors.length}
          tone={data.errors.length ? "danger" : undefined}
        />
      </div>
      {data.unmatchedStaff.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Unmatched staff ({data.unmatchedStaff.length})
          </summary>
          <div className="mt-2 break-all text-muted-foreground">
            {data.unmatchedStaff.join(", ")}
          </div>
        </details>
      )}
      {data.unmatchedTheatres && data.unmatchedTheatres.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Unmatched theatres ({data.unmatchedTheatres.length})
          </summary>
          <div className="mt-2 break-all text-muted-foreground">
            {data.unmatchedTheatres.join(", ")}
          </div>
          <p className="mt-1 italic text-muted-foreground">
            Add these in Admin → Theatres so future syncs can link them.
          </p>
        </details>
      )}
      {data.skipped.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Skipped rows ({data.skipped.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
            {data.skipped.slice(0, 200).map((s, i) => (
              <li key={i}>
                {s.label} — <span className="italic">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.errors.length > 0 && (
        <details open className="rounded border border-destructive/40 p-2">
          <summary className="cursor-pointer font-medium text-destructive">
            Errors ({data.errors.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-destructive">
            {data.errors.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.label}</span> — {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.sampleKeys.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Detected CLWRota columns ({data.sampleKeys.length})
          </summary>
          <div className="mt-2 break-all text-muted-foreground">{data.sampleKeys.join(", ")}</div>
        </details>
      )}
      {data.rawPreview && data.total === 0 && (
        <div>
          <div className="font-medium text-foreground">Response preview:</div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px]">
            {data.rawPreview}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------- StaffSyncResultPanel ----------

type StaffSyncData = {
  total: number;
  insertedCount: number;
  updated: number;
  unchangedCount: number;
  skipped: Array<{ label: string; reason: string }>;
  errors: Array<{ label: string; error: string }>;
  insertedList: Array<{ name: string; email: string }>;
  sampleKeys: string[];
  rawPreview?: string;
  emailDiagnostics?: {
    rowsWithEmail: number;
    rowsBlankEmail: number;
    rowsInvalidEmail: number;
    rowsDuplicateEmail: number;
    emailFieldsTried: string[];
    detectedEmailFields: string[];
  };
};

export function StaffSyncResultPanel({ data }: { data: StaffSyncData }) {
  return (
    <div className="rounded-md border border-border p-3 text-xs space-y-3">
      <div className="font-medium text-sm">Last staff sync results</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Rows pulled" value={data.total} />
        <Stat label="Added" value={data.insertedCount} tone="success" />
        <Stat label="Updated" value={data.updated} tone="info" />
        <Stat label="Unchanged" value={data.unchangedCount} />
        <Stat
          label="Skipped / errors"
          value={data.skipped.length + data.errors.length}
          tone={data.errors.length ? "danger" : undefined}
        />
      </div>
      {data.emailDiagnostics && (
        <details open className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">Email matching diagnostics</summary>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="With email" value={data.emailDiagnostics.rowsWithEmail} tone="success" />
            <Stat
              label="Blank / missing"
              value={data.emailDiagnostics.rowsBlankEmail}
              tone={data.emailDiagnostics.rowsBlankEmail ? "danger" : undefined}
            />
            <Stat
              label="Invalid format"
              value={data.emailDiagnostics.rowsInvalidEmail}
              tone={data.emailDiagnostics.rowsInvalidEmail ? "danger" : undefined}
            />
            <Stat
              label="Duplicates in feed"
              value={data.emailDiagnostics.rowsDuplicateEmail}
              tone={data.emailDiagnostics.rowsDuplicateEmail ? "danger" : undefined}
            />
          </div>
          <div className="mt-2 space-y-1 text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">Email fields tried:</span>{" "}
              {data.emailDiagnostics.emailFieldsTried.join(", ")}
            </div>
            <div>
              <span className="font-medium text-foreground">
                Email fields detected in payload:
              </span>{" "}
              {data.emailDiagnostics.detectedEmailFields.length
                ? data.emailDiagnostics.detectedEmailFields.join(", ")
                : "none — staff report has no recognised email column"}
            </div>
          </div>
        </details>
      )}
      {data.insertedList.length > 0 && (
        <details open className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium text-success">
            Added profiles ({data.insertedList.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
            {data.insertedList.map((p) => (
              <li key={p.email}>
                {p.name} <span className="opacity-70">&lt;{p.email}&gt;</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.skipped.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Skipped rows ({data.skipped.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
            {data.skipped.map((s, i) => (
              <li key={`${s.label}-${i}`}>
                {s.label} — <span className="italic">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.errors.length > 0 && (
        <details open className="rounded border border-destructive/40 p-2">
          <summary className="cursor-pointer font-medium text-destructive">
            Errors ({data.errors.length})
          </summary>
          <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-destructive">
            {data.errors.map((e, i) => (
              <li key={`${e.label}-${i}`}>
                <span className="font-medium">{e.label}</span> — {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.sampleKeys.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">
            Detected CLWRota columns ({data.sampleKeys.length})
          </summary>
          <div className="mt-2 break-all text-muted-foreground">
            {data.sampleKeys.join(", ")}
          </div>
        </details>
      )}
      {data.rawPreview && data.total === 0 && (
        <div>
          <div className="font-medium text-foreground">Response preview:</div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px]">
            {data.rawPreview}
          </pre>
        </div>
      )}
    </div>
  );
}
