import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Activity, AlertTriangle, CalendarClock, Moon } from "lucide-react";
import {
  getIcuConsultantEvidence,
  listIcuEvidenceStaff,
  type IcuConsultantEvidence,
  type IcuEvidenceStaffOption,
} from "@/features/analytics/icu-evidence.functions";
import { formatDateWithWeekdayGB } from "@/lib/utils";

const searchSchema = z.object({
  staff: fallback(z.string(), "").default(""),
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/admin/icu-evidence")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "My ICU evidence — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "One consultant's intensive care sessions, PA credits and any differences between the rota and CLWRota, ready for appraisal and revalidation.",
      },
      { property: "og:title", content: "Per-consultant ICU evidence" },
      {
        property: "og:description",
        content:
          "Every intensive care session credited to one doctor, with PAs and any rota/CLWRota discrepancies.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: IcuEvidencePage,
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const SESSION_LABEL: Record<string, string> = {
  am: "AM",
  pm: "PM",
  eve: "Evening",
  night: "Night",
};

const DUTY_LABEL: Record<string, string> = {
  icu_consultant_oncall: "ICU consultant on-call",
  icu_ct2_plus: "ICU CT2+",
  icu_trainee: "ICU trainee",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function IcuEvidencePage() {
  const { hasRole, loading, user } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const isCoordinator = hasRole("admin") || hasRole("rota_coordinator");

  const fromDate = ISO_RE.test(search.from) ? search.from : isoDaysAgo(365);
  const toDate = ISO_RE.test(search.to) ? search.to : todayIso();
  const staffId = isCoordinator && search.staff ? search.staff : "";

  const [fromInput, setFromInput] = useState(fromDate);
  const [toInput, setToInput] = useState(toDate);
  useEffect(() => setFromInput(fromDate), [fromDate]);
  useEffect(() => setToInput(toDate), [toDate]);

  const apply = (next: { staff?: string; from?: string; to?: string }) =>
    navigate({
      search: { staff: staffId, from: fromDate, to: toDate, ...next },
    });

  const appraisalYear = () => {
    const now = new Date();
    const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    apply({ from: `${y}-04-01`, to: `${y + 1}-03-31` });
  };

  const staffFn = useServerFn(listIcuEvidenceStaff);
  const { data: staffOptions } = useQuery({
    queryKey: ["icu-evidence-staff"],
    enabled: isCoordinator,
    queryFn: () => staffFn({ data: {} }) as Promise<IcuEvidenceStaffOption[]>,
  });

  const evidenceFn = useServerFn(getIcuConsultantEvidence);
  const { data, isLoading, error } = useQuery({
    queryKey: ["icu-evidence", staffId || user?.id, fromDate, toDate],
    queryFn: () =>
      evidenceFn({
        data: {
          ...(staffId ? { staffId } : {}),
          startIso: fromDate,
          endIso: toDate,
        },
      }) as Promise<IcuConsultantEvidence>,
  });

  const totals = useMemo(() => {
    const t = data?.tally;
    return {
      days: t?.days ?? 0,
      sessions: t?.sessions ?? 0,
      onCalls: t?.onCalls ?? 0,
      pas: t?.totalPas ?? 0,
      clwrotaPas: t?.clwrotaPas ?? 0,
      estimatedPas: t?.estimatedPas ?? 0,
    };
  }, [data]);

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={data ? `ICU evidence — ${data.staffName}` : "ICU evidence"}
        description="One doctor's intensive care sessions over a period you choose, the PAs credited for them, and anything where the rota and CLWRota disagree — a single sheet to take to appraisal or revalidation."
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          {isCoordinator && (
            <div className="space-y-1">
              <Label>Doctor</Label>
              <Select
                value={staffId || "me"}
                onValueChange={(v) => apply({ staff: v === "me" ? "" : v })}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Choose a doctor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">Me</SelectItem>
                  {(staffOptions ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="icu-evidence-from">From</Label>
            <Input
              id="icu-evidence-from"
              type="date"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="icu-evidence-to">To</Label>
            <Input
              id="icu-evidence-to"
              type="date"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              className="w-44"
            />
          </div>
          <Button
            onClick={() => apply({ from: fromInput, to: toInput })}
            disabled={!ISO_RE.test(fromInput) || !ISO_RE.test(toInput) || fromInput > toInput}
          >
            Show
          </Button>
          <Button variant="outline" onClick={appraisalYear}>
            Appraisal year
          </Button>
          <Button variant="outline" onClick={() => apply({ from: isoDaysAgo(365), to: todayIso() })}>
            Last 12 months
          </Button>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Could not load this record."}
          </CardContent>
        </Card>
      )}

      {isLoading && <PageLoading />}

      {data && !isLoading && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Days on ICU" value={String(totals.days)} icon={CalendarClock} />
            <StatCard title="Daytime sessions" value={String(totals.sessions)} icon={Activity} />
            <StatCard title="On-calls" value={String(totals.onCalls)} icon={Moon} />
            <StatCard
              title="PAs credited"
              value={totals.pas.toFixed(2)}
              icon={Activity}
              description={`${totals.clwrotaPas.toFixed(2)} from CLWRota · ${totals.estimatedPas.toFixed(2)} estimated`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4" />
                Discrepancies
                <Badge variant={data.discrepancies.length > 0 ? "destructive" : "secondary"}>
                  {data.discrepancies.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.discrepancies.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every session on the rota matches a CLWRota record for this period.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Session</TableHead>
                      <TableHead>What differs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.discrepancies.map((d) => (
                      <TableRow key={`${d.kind}-${d.sessionDate}-${d.session}`}>
                        <TableCell className="whitespace-nowrap">
                          {formatDateWithWeekdayGB(d.sessionDate)}
                        </TableCell>
                        <TableCell>{SESSION_LABEL[d.session] ?? d.session}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{d.detail}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Sessions ({data.sessions.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No intensive care sessions recorded in this period.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Session</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Where / how identified</TableHead>
                      <TableHead className="text-right">PAs</TableHead>
                      <TableHead>Evidence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.sessions.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="whitespace-nowrap">
                          {formatDateWithWeekdayGB(s.sessionDate)}
                        </TableCell>
                        <TableCell>{SESSION_LABEL[s.session] ?? s.session}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <span>{DUTY_LABEL[s.dutyType] ?? s.dutyType}</span>
                            {s.extraType && <Badge variant="outline">{s.extraType}</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[22rem] text-sm text-muted-foreground">
                          {s.matchedValue ?? s.placeName ?? s.roleLabel ?? "—"}
                          {s.sharedWith.length > 0 && (
                            <div className="text-xs">With {s.sharedWith.join(", ")}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.paCredit != null ? s.paCredit.toFixed(2) : "—"}
                        </TableCell>
                        <TableCell>
                          {s.hasSourceRecord ? (
                            <Badge variant="secondary">
                              CLWRota {s.clwrotaExternalId ?? "record"}
                            </Badge>
                          ) : (
                            <Badge variant="destructive">No source record</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
