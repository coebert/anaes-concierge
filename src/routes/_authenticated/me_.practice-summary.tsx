import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { QueryErrorNotice } from "@/components/query-state-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  appraisalYearLabel,
  appraisalYearOf,
  appraisalYearRange,
} from "@/features/analytics/appraisal-year";
import { getMyPracticeSummary } from "@/features/practice-summary/practice-summary.functions";
import {
  isValidRange,
  MAX_RANGE_DAYS,
  practiceSummaryCsv,
} from "@/features/practice-summary/practice-summary";
import { PracticeSummaryReport } from "@/features/practice-summary/PracticeSummaryReport";
import { downloadTextFile } from "@/features/practice-summary/download";

const search = z.object({
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/me_/practice-summary")({
  validateSearch: zodValidator(search),
  head: () => ({
    meta: [
      { title: "My practice summary — appraisal evidence" },
      {
        name: "description",
        content:
          "Your own rostered clinical activity for an appraisal year or chosen dates: duties, specialties, on-call, monthly trend, PAs and data coverage, ready to print or export.",
      },
      { property: "og:title", content: "My practice summary" },
      {
        property: "og:description",
        content: "A printable summary of your own rostered clinical activity for appraisal.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PracticeSummaryPage,
});

function PracticeSummaryPage() {
  const { from: qFrom, to: qTo } = Route.useSearch();
  const navigate = Route.useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const currentYear = appraisalYearOf(today);
  const fallbackRange = appraisalYearRange(currentYear);
  const valid = isValidRange(qFrom, qTo);
  const from = valid ? qFrom : fallbackRange.from;
  const to = valid ? qTo : fallbackRange.to;
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [reflection, setReflection] = useState("");
  const fetchSummary = useServerFn(getMyPracticeSummary);

  const q = useQuery({
    queryKey: ["my-practice-summary", from, to],
    queryFn: () => fetchSummary({ data: { from, to } }),
  });

  const yearValue = useMemo(() => {
    for (let y = currentYear; y > currentYear - 6; y -= 1) {
      const r = appraisalYearRange(y);
      if (r.from === from && r.to === to) return String(y);
    }
    return "custom";
  }, [from, to, currentYear]);

  const setRange = (f: string, t: string) => {
    setDraftFrom(f);
    setDraftTo(t);
    navigate({ search: { from: f, to: t } });
  };
  const draftValid = isValidRange(draftFrom, draftTo);

  const exportCsv = () => {
    if (!q.data) return;
    downloadTextFile(
      practiceSummaryCsv(q.data.summary, { generatedAt: q.data.generatedAt }),
      `practice-summary_${from}_to_${to}.csv`,
      "text/csv;charset=utf-8",
    );
  };

  return (
    <div data-print-report className="space-y-4">
      <PageHeader
        title="My practice summary"
        description="Your own rostered activity from the rota, for appraisal evidence. Only you can see this summary."
        actions={
          <div data-print-hide className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => window.print()} disabled={!q.data}>
              <Printer className="mr-1 h-4 w-4" aria-hidden /> Print / save as PDF
            </Button>
            <Button onClick={exportCsv} disabled={!q.data}>
              <Download className="mr-1 h-4 w-4" aria-hidden /> Download CSV
            </Button>
          </div>
        }
      />

      <Card data-print-hide>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="space-y-1">
            <Label htmlFor="ps-year">Appraisal year</Label>
            <Select
              value={yearValue}
              onValueChange={(v) => {
                if (v === "custom") return;
                const r = appraisalYearRange(Number(v));
                setRange(r.from, r.to);
              }}
            >
              <SelectTrigger id="ps-year" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 6 }, (_, i) => currentYear - i).map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {appraisalYearLabel(y)} (Apr–Mar)
                  </SelectItem>
                ))}
                <SelectItem value="custom" disabled>
                  Custom dates
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ps-from">From</Label>
            <Input
              id="ps-from"
              type="date"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ps-to">To</Label>
            <Input
              id="ps-to"
              type="date"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            disabled={!draftValid}
            onClick={() => setRange(draftFrom, draftTo)}
          >
            Show these dates
          </Button>
          {!draftValid && (
            <p className="text-xs text-destructive">
              The start must be on or before the end, at most {MAX_RANGE_DAYS} days apart.
            </p>
          )}
        </CardContent>
      </Card>

      {q.isLoading ? (
        <PageLoading />
      ) : q.isError ? (
        <QueryErrorNotice
          error={q.error}
          onRetry={() => q.refetch()}
          what="your practice summary"
        />
      ) : q.data ? (
        <PracticeSummaryReport
          data={q.data}
          reflection={reflection}
          setReflection={setReflection}
        />
      ) : null}
    </div>
  );
}
