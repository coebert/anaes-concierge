import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle } from "lucide-react";
import {
  getPaByConsultant,
  type PaByConsultantResult,
} from "@/features/analytics/pa-by-consultant.functions";

const searchSchema = z.object({
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/admin/pa-by-consultant")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "PAs by consultant — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "Each consultant's intensive care PAs over a chosen period, split into PAs recorded by CLWRota and rule-based estimates, with evidence gaps flagged.",
      },
      { property: "og:title", content: "PAs by consultant" },
      {
        property: "og:description",
        content:
          "Recorded CLWRota PAs per consultant for a chosen date range, with evidence gaps flagged.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PaByConsultantPage,
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function PaByConsultantPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const fromDate = ISO_RE.test(search.from) ? search.from : isoDaysAgo(365);
  const toDate = ISO_RE.test(search.to) ? search.to : todayIso();

  const [fromInput, setFromInput] = useState(fromDate);
  const [toInput, setToInput] = useState(toDate);
  useEffect(() => setFromInput(fromDate), [fromDate]);
  useEffect(() => setToInput(toDate), [toDate]);

  const apply = (next: { from?: string; to?: string }) =>
    navigate({ search: { from: fromDate, to: toDate, ...next } });

  const appraisalYear = () => {
    const now = new Date();
    const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    apply({ from: `${y}-04-01`, to: `${y + 1}-03-31` });
  };

  const fn = useServerFn(getPaByConsultant);
  const { data, isLoading, error } = useQuery({
    queryKey: ["pa-by-consultant", fromDate, toDate],
    queryFn: () => fn({ data: { startIso: fromDate, endIso: toDate } }) as Promise<PaByConsultantResult>,
  });

  const totals = data
    ? data.rows.reduce(
        (acc, r) => ({
          recordedPas: acc.recordedPas + r.recordedPas,
          estimatedPas: acc.estimatedPas + r.estimatedPas,
          gapSessions: acc.gapSessions + r.gapSessions,
        }),
        { recordedPas: 0, estimatedPas: 0, gapSessions: 0 },
      )
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="PAs by consultant"
        description="Each consultant's intensive care PAs over a period you choose — split into PAs CLWRota actually recorded and PAs estimated from the rota rules, with evidence gaps flagged so you can chase missing source records."
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="space-y-1">
            <Label htmlFor="pa-from">From</Label>
            <Input
              id="pa-from"
              type="date"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pa-to">To</Label>
            <Input
              id="pa-to"
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
            {error instanceof Error ? error.message : "Could not load PA totals."}
          </CardContent>
        </Card>
      )}

      {isLoading && <PageLoading />}

      {data && !isLoading && totals && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {data.rows.length} consultants · {totals.recordedPas.toFixed(2)} recorded PAs ·{" "}
              {totals.estimatedPas.toFixed(2)} estimated
              {totals.gapSessions > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {totals.gapSessions} sessions without a recorded PA
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No intensive care sessions recorded in this period.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Consultant</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Recorded PAs (CLWRota)</TableHead>
                    <TableHead className="text-right">Estimated PAs</TableHead>
                    <TableHead className="text-right">Total PAs</TableHead>
                    <TableHead>Evidence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.staffId} data-testid={`pa-row-${r.staffId}`}>
                      <TableCell>
                        <Link
                          to="/admin/icu-evidence"
                          search={{ staff: r.staffId, from: fromDate, to: toDate }}
                          className="font-medium text-primary hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.grade && (
                          <span className="ml-2 text-xs text-muted-foreground">{r.grade}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.sessions}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.recordedPas.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.estimatedPas.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {r.totalPas.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        {r.gapSessions === 0 ? (
                          <Badge variant="secondary">Fully recorded</Badge>
                        ) : (
                          <Badge
                            variant="destructive"
                            className="gap-1"
                            title={`No recorded PA on: ${r.gapDates.join(", ")}`}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {r.gapSessions} gap{r.gapSessions === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
