import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WEEK_STATUS_LABEL } from "@/features/audit/rota-week-status";
import type { PracticeSummary, WeekImport, WeekPublication } from "./practice-summary";
import type { PracticeSummaryResult } from "./practice-summary.functions";

const IMPORT_LABEL: Record<WeekImport, string> = {
  current: "Imported, current",
  stale: "Imported, not refreshed recently",
  incomplete: "Partly imported",
  attempt_problem: "Last import had a problem",
  not_tracked: "Import not tracked",
  before_tracking: "Before import tracking began",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const n2 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

type Data = PracticeSummaryResult;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="break-inside-avoid">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function PracticeSummaryReport({
  data,
  reflection,
  setReflection,
}: {
  data: Data;
  reflection: string;
  setReflection: (v: string) => void;
}) {
  const s: PracticeSummary = data.summary;
  const empty = s.scope.rosteredEntries + s.scope.namedOnOtherEntries === 0;
  const maxMonth = Math.max(1, ...s.months.map((m) => m.entries));
  const pubOrder: WeekPublication[] = [
    "published",
    "setup",
    "not_setup",
    "mixed",
    "unknown",
    "other",
    "not_observed",
  ];
  const impOrder: WeekImport[] = [
    "current",
    "stale",
    "incomplete",
    "attempt_problem",
    "before_tracking",
    "not_tracked",
  ];

  return (
    <div className="space-y-4">
      <Card className="break-inside-avoid">
        <CardContent className="space-y-1 p-4 text-sm">
          <div className="text-lg font-semibold">
            {data.clinician.name ?? "Your summary"}
            {data.clinician.grade ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({data.clinician.grade})
              </span>
            ) : null}
          </div>
          <div>
            {fmtDate(s.from)} to {fmtDate(s.to)} · generated{" "}
            {fmtDate(data.generatedAt.slice(0, 10))} {data.generatedAt.slice(11, 16)} UTC
          </div>
        </CardContent>
      </Card>

      <Alert className="break-inside-avoid">
        <AlertTitle>What this summary is — and isn't</AlertTitle>
        <AlertDescription>
          These are entries rostered to you on CLWRota and imported into the app. They are not a
          record that the work was delivered, and they contain no case numbers, procedures, patient
          outcomes or evidence of competence. Entries after {fmtDate(s.today)} are planned work that
          hasn't happened yet ({s.scope.futureEntries} in this range). Leave is shown separately
          below and is not counted as clinical work.
        </AlertDescription>
      </Alert>

      {empty ? (
        <Alert className="break-inside-avoid">
          <AlertTitle>No rota entries for you in these dates</AlertTitle>
          <AlertDescription>
            Either nothing was rostered to you, or the rota for these dates hasn't been imported —
            see Data coverage below.
          </AlertDescription>
        </Alert>
      ) : null}

      <Section
        title="Leave"
        description="Your approved leave in these dates, in working days (Monday to Friday), counted the same way as your leave balance."
      >
        {data.leave.approvedRequests === 0 ? (
          <p className="text-sm text-muted-foreground">No approved leave in these dates.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Working days</TableHead>
                <TableHead className="text-right">Of which still to come</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.leave.byType.map((l) => (
                <TableRow key={l.type}>
                  <TableCell>{l.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{n2(l.workingDays)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {n2(l.plannedWorkingDays)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">Total</TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {data.leave.approvedRequests}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {n2(data.leave.workingDays)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {n2(data.leave.plannedWorkingDays)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Leave that crosses the start or end date is counted only inside these dates.
          {data.leave.fromClwrota > 0
            ? " CLWRota doesn't send half-days, so leave imported from it counts as whole days."
            : ""}
          {data.leave.pendingRequests > 0
            ? ` ${data.leave.pendingRequests} request(s) still waiting for a decision aren't counted.`
            : ""}
          {data.leave.notTakenRequests > 0
            ? ` ${data.leave.notTakenRequests} rejected or cancelled request(s) aren't counted.`
            : ""}
        </p>
      </Section>

      <Section
        title="Overall scope"
        description="Days, sessions, on-calls and PAs use the same rules as the appraisal-year and specialty audits."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Days with daytime work" value={s.totals.days} />
          <Stat label="Daytime sessions (AM/PM)" value={s.totals.sessions} />
          <Stat
            label="On-calls (evening/night)"
            value={s.totals.onCalls}
            hint="Several halves on one date count once"
          />
          <Stat label="Weekend days" value={s.totals.weekendDays} />
          <Stat
            label="Total PAs"
            value={n2(s.totals.totalPas)}
            hint={`${n2(s.totals.clwrotaPas)} recorded by CLWRota · ${n2(s.totals.estimatedPas)} estimated`}
          />
          <Stat label="Job-planned PAs" value={n2(s.totals.plannedPas)} />
          <Stat
            label="Extra / locum / WLI / SAG"
            value={`${s.totals.extraSessions} entries`}
            hint={`${n2(s.totals.extraPas)} PAs, kept separate`}
          />
          <Stat
            label="Distinct half-days"
            value={s.scope.distinctHalfDays}
            hint={`${s.scope.distinctDays} distinct dates`}
          />
        </div>
        <Table className="mt-3">
          <TableBody>
            <TableRow>
              <TableCell>Entries rostered to you</TableCell>
              <TableCell className="text-right tabular-nums">{s.scope.rosteredEntries}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                Another doctor's entries that name you as attending consultant (credited to you by
                the department rule)
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.scope.namedOnOtherEntries}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                Half-days credited by more than one entry (each entry is counted, as in the
                department rule)
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.scope.halfDaysWithSeveralEntries}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                Entries that are one half of an all-day CLWRota entry split into AM and PM
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.scope.splitAllDayEntries}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Entries up to today / after today</TableCell>
              <TableCell className="text-right tabular-nums">
                {s.scope.pastEntries} / {s.scope.futureEntries}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Activity by duty and half-day"
        description="Counts of entries. A half-day with two entries appears twice."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Duty</TableHead>
              <TableHead className="text-right">AM</TableHead>
              <TableHead className="text-right">PM</TableHead>
              <TableHead className="text-right">Evening</TableHead>
              <TableHead className="text-right">Night</TableHead>
              <TableHead className="text-right">All</TableHead>
              <TableHead className="text-right">of which extra</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.dutyGroups.map((g) => (
              <TableRow key={g.group}>
                <TableCell>{g.group}</TableCell>
                <TableCell className="text-right tabular-nums">{g.halves.am}</TableCell>
                <TableCell className="text-right tabular-nums">{g.halves.pm}</TableCell>
                <TableCell className="text-right tabular-nums">{g.halves.eve}</TableCell>
                <TableCell className="text-right tabular-nums">{g.halves.night}</TableCell>
                <TableCell className="text-right tabular-nums">{g.entries}</TableCell>
                <TableCell className="text-right tabular-nums">{g.extraEntries}</TableCell>
              </TableRow>
            ))}
            {s.dutyGroups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No entries.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="By specialty or area"
        description="Theatre lists by the list's surgical specialty; other work by duty."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Area</TableHead>
              <TableHead className="text-right">Days</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">On-calls</TableHead>
              <TableHead className="text-right">Weekend days</TableHead>
              <TableHead className="text-right">PAs</TableHead>
              <TableHead className="text-right">of which estimated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.areas.map((a) => (
              <TableRow key={a.area}>
                <TableCell>{a.area}</TableCell>
                <TableCell className="text-right tabular-nums">{a.days}</TableCell>
                <TableCell className="text-right tabular-nums">{a.sessions}</TableCell>
                <TableCell className="text-right tabular-nums">{a.onCalls}</TableCell>
                <TableCell className="text-right tabular-nums">{a.weekendDays}</TableCell>
                <TableCell className="text-right tabular-nums">{n2(a.totalPas)}</TableCell>
                <TableCell className="text-right tabular-nums">{n2(a.estimatedPas)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {s.locations.length > 0 ? (
        <Section title="Theatre locations" description="Entries linked to a theatre list, by room.">
          <Table>
            <TableBody>
              {s.locations.map((l) => (
                <TableRow key={l.location}>
                  <TableCell>{l.location}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.entries}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}

      <Section
        title="On-call"
        description="Evening and night halves; several halves on one date count as one on-call."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="On-call dates" value={s.onCall.onCallDates} />
          <Stat label="Weekend on-call dates" value={s.onCall.weekendOnCallDates} />
          <Stat
            label="Daytime on-call duty entries"
            value={s.onCall.daytimeOnCallDutyEntries}
            hint="On-call duty rostered as AM/PM"
          />
        </div>
        {s.onCall.byDuty.length > 0 ? (
          <ul className="mt-2 text-sm">
            {s.onCall.byDuty.map((d) => (
              <li key={d.group}>
                {d.group}: {d.dates} date{d.dates === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {(s.icu || s.obstetrics || s.teaching) && (
        <Section
          title="Intensive care, obstetrics and teaching"
          description="Shown only where your rota has entries classified as these duties."
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {s.icu ? (
              <Stat
                label="Intensive care"
                value={`${s.icu.entries} entries`}
                hint={`${s.icu.daytimeSessions} daytime sessions · ${s.icu.onCallDates} on-call dates`}
              />
            ) : null}
            {s.obstetrics ? (
              <Stat
                label="Obstetrics"
                value={`${s.obstetrics.entries} entries`}
                hint={`${s.obstetrics.daytimeSessions} daytime sessions · ${s.obstetrics.onCallDates} on-call dates`}
              />
            ) : null}
            {s.teaching ? (
              <Stat
                label="Teaching (rostered)"
                value={`${s.teaching.entries} entries`}
                hint={`${s.teaching.daytimeSessions} daytime sessions`}
              />
            ) : null}
          </div>
        </Section>
      )}
      <p className="text-xs text-muted-foreground">
        Supervision isn't reported: the rota's role on each list comes from the doctor's grade, not
        from a record of who supervised whom, so it can't evidence supervision.
      </p>

      <Section title="Month by month">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Daytime sessions</TableHead>
              <TableHead className="text-right">On-call dates</TableHead>
              <TableHead className="text-right">ICU entries</TableHead>
              <TableHead className="text-right">PAs</TableHead>
              <TableHead className="w-1/4" aria-label="Trend" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.months.map((m) => (
              <TableRow key={m.month}>
                <TableCell>{monthLabel(m.month)}</TableCell>
                <TableCell className="text-right tabular-nums">{m.entries}</TableCell>
                <TableCell className="text-right tabular-nums">{m.daytimeSessions}</TableCell>
                <TableCell className="text-right tabular-nums">{m.onCallDates}</TableCell>
                <TableCell className="text-right tabular-nums">{m.icuEntries}</TableCell>
                <TableCell className="text-right tabular-nums">{n2(m.totalPas)}</TableCell>
                <TableCell>
                  <div className="h-2 rounded bg-muted print:[print-color-adjust:exact]">
                    <div
                      className="h-2 rounded bg-primary print:[print-color-adjust:exact]"
                      style={{ width: `${(m.entries / maxMonth) * 100}%` }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-2 text-xs text-muted-foreground">
          A month with no entries may mean nothing was rostered or that rota data for it wasn't
          imported.
        </p>
      </Section>

      <Section
        title="Data coverage"
        description="How each entry's week stood in the rota feed. Draft (Not setup) weeks may hold planned entries only."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-sm font-medium">Week status in CLWRota</div>
            {!data.weekStatusInstalled ? (
              <p className="text-xs text-muted-foreground">Week status isn't recorded yet.</p>
            ) : null}
            <ul className="text-sm">
              {pubOrder
                .filter((k) => s.coverage.byPublication[k])
                .map((k) => (
                  <li key={k}>
                    {WEEK_STATUS_LABEL[k]}: {s.coverage.byPublication[k]} entries
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-sm font-medium">Rota import</div>
            {data.importTrackingSince ? (
              <p className="text-xs text-muted-foreground">
                Import tracking began {fmtDate(data.importTrackingSince.slice(0, 10))}; earlier
                weeks can't be confirmed complete.
              </p>
            ) : null}
            <ul className="text-sm">
              {impOrder
                .filter((k) => s.coverage.byImport[k])
                .map((k) => (
                  <li key={k}>
                    {IMPORT_LABEL[k]}: {s.coverage.byImport[k]} entries
                  </li>
                ))}
            </ul>
          </div>
        </div>
        <Table className="mt-3">
          <TableBody>
            <TableRow>
              <TableCell>Theatre entries not linked to a list (specialty unknown)</TableCell>
              <TableCell className="text-right tabular-nums">
                {s.quality.theatreNotLinkedToList}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Entries on a list with no specialty recorded</TableCell>
              <TableCell className="text-right tabular-nums">
                {s.quality.listWithoutSpecialty}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                Entries without a CLWRota PA value (PAs estimated from rota rules)
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.quality.estimatedPaEntries}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Entries edited in the app by a coordinator</TableCell>
              <TableCell className="text-right tabular-nums">
                {s.quality.locallyEditedEntries}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Entries added in the app (not from CLWRota)</TableCell>
              <TableCell className="text-right tabular-nums">{s.quality.enteredInApp}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Excluded: entries with no recognised half-day</TableCell>
              <TableCell className="text-right tabular-nums">
                {s.quality.unknownHalfExcluded}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="Definitions">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <b>Entry</b>: one rota row credited to you for one half-day. You're credited when it's
            rostered to you, or when another doctor's entry names you as attending consultant.
          </li>
          <li>
            <b>Daytime session</b>: an AM or PM entry. <b>Day</b>: a date with at least one daytime
            session, including extra sessions; each date counts once, however many specialties it
            covers.
          </li>
          <li>
            <b>On-call</b>: evening or night entries; several on one date count as one on-call.
          </li>
          <li>
            <b>PAs</b>: CLWRota's own PA value where recorded; otherwise{" "}
            {n2(1 / (data.rules.sessions_per_pa || 1))} PA per session,{" "}
            {n2(data.rules.oncall_pa_credit)} per on-call and {n2(data.rules.weekend_pa_credit)} per
            weekend day (weekend credit replaces session credit), from the department rota rules.
          </li>
          <li>
            <b>Extra</b>: entries CLWRota marks as extra, locum, WLI or SAG — shown separately from
            job-planned work.
          </li>
          <li>
            <b>Week status</b>: Published, Setup or Not setup as the rota feed reported it when the
            app imported that week; not when it was published.
          </li>
        </ul>
      </Section>

      <Section
        title="My reflection (optional)"
        description="Not saved anywhere. It is printed with this page; copy it somewhere safe before you leave."
      >
        <Textarea
          data-print-hide
          value={reflection}
          onChange={(e) => setReflection(e.target.value)}
          rows={5}
          maxLength={4000}
          placeholder="Notes for your appraiser…"
        />
        <div className="hidden whitespace-pre-wrap text-sm print:block">{reflection || "—"}</div>
      </Section>
    </div>
  );
}
