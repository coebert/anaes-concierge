import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Info } from "lucide-react";

/**
 * Plain-English metric guide shared by the personal and admin wellbeing
 * pages. Content is kept in sync with:
 *   - src/features/wellbeing/wellbeing-score.ts  (driver weights & bands)
 *   - src/lib/attrition-risk.ts                  (attrition factors & weights)
 *   - src/lib/bradford-factor.ts                 (Bradford formula)
 * If you change a weight or a formula in code, update the copy here too.
 */

/** Friendly labels for the raw driver keys emitted by computeWellbeing. */
export const WELLBEING_DRIVER_LABEL: Record<string, string> = {
  nights: "Night sessions",
  weekends: "Weekend sessions",
  unsocial: "Unsocial-hours share",
  shortnotice: "Short-notice changes",
  leave: "Rejected / cancelled leave",
  exceptions: "Exception reports",
  bradford: "Bradford Factor (sickness pattern)",
};

interface Row {
  name: string;
  weight?: string;
  what: string;
  how: string;
}

const WELLBEING_ROWS: Row[] = [
  {
    name: "Night sessions",
    weight: "22%",
    what: "How often you're rostered overnight — a common fatigue concern in shift work.",
    how: "Number of sessions with session = 'night' in the last 90 days, normalised so that ~4 nights/month reaches the full weight.",
  },
  {
    name: "Weekend sessions",
    weight: "18%",
    what: "How much of your weekend time the rota is consuming.",
    how: "Count of sessions whose date falls on a Saturday or Sunday in the last 90 days, normalised so ~3 weekend sessions/month reaches full weight.",
  },
  {
    name: "Unsocial-hours share",
    weight: "12%",
    what: "The proportion of your work happening at night, evenings or weekends — a load-shape indicator that matters even when totals look reasonable.",
    how: "Sessions that are a night, an evening OR on a weekend (each session counted once, so a weekend night is one session) ÷ total sessions over the 90-day window. 50% or more reaches full weight.",
  },
  {
    name: "Short-notice changes",
    weight: "18%",
    what: "How often your rota was moved with under 48 hours' notice — which can cut into recovery time.",
    how: "Rota change-log entries where hours_before_session ≤ 48 (in either direction). 6 such changes reaches full weight.",
  },
  {
    name: "Rejected / cancelled leave",
    weight: "10%",
    what: "How often requested leave didn't happen — a signal of unmet recovery needs.",
    how: "Leave requests with status = 'rejected' or 'cancelled' whose decision date (or start date if no decision date) is inside the 90-day window. 3 such events reaches full weight.",
  },
  {
    name: "Exception reports",
    weight: "10%",
    what: "How often you flagged that hours, rest, education or safety didn't match the rota — a proxy for workload strain.",
    how: "Non-withdrawn exception reports whose event_date is inside the 90-day window. 4 reports reaches full weight.",
  },
  {
    name: "Bradford Factor",
    weight: "10%",
    what: "A standard NHS sickness-pattern score. Frequent short spells score higher than a single long spell of the same total length.",
    how: "Bradford = S² × D, where S = number of separate approved sick spells in the last 12 months and D = total sick days. A score of 300+ reaches full weight.",
  },
];

const ATTRITION_ROWS: Row[] = [
  {
    name: "Wellbeing score",
    weight: "30%",
    what: "The wellbeing score above, reused as one input. Its weight is a design choice, not a measured relationship with leaving.",
    how: "(100 − wellbeing score) ÷ 100. A score of 0 fully contributes; a score of 100 doesn't contribute at all.",
  },
  {
    name: "Pulse-survey trend",
    weight: "13%",
    what: "Intended to reflect whether the person's own survey answers are getting more negative. NOT CURRENTLY MEASURED: no per-person survey trend is connected yet, so this is shown as 'not assessed' for everyone.",
    how: "When unavailable (currently always), a fixed 30% placeholder contributes, as in the original rubric. A measured trend would use average change vs the previous cycle on a −4…+4 scale, with −2 or worse fully contributing.",
  },
  {
    name: "Bradford Factor",
    weight: "15%",
    what: "Sickness-absence pattern in the last 12 months (same score used in the wellbeing driver).",
    how: "Bradford score ÷ 400. A score of 400+ fully contributes.",
  },
  {
    name: "Leave denial rate",
    weight: "12%",
    what: "The share of leave decisions that went against the person.",
    how: "rejected ÷ (approved + rejected) for decisions made in the last 12 months (decision date; falls back to request date, then start date, for older rows). 40% or more fully contributes.",
  },
  {
    name: "Short-notice changes",
    weight: "12%",
    what: "Rostering disruption over the whole year (the wellbeing driver only looks at 90 days).",
    how: "Count of rota changes with ≤48h notice for sessions in the last 12 months up to today (future sessions are excluded). 20 or more fully contributes.",
  },
  {
    name: "Time since last annual leave",
    weight: "10%",
    what: "How long the person has gone without a proper break.",
    how: "Days since the end of the most recent approved annual leave that has already started (0 while on leave; future bookings don't count). 180 days fully contributes. No annual leave taken on record contributes 70%.",
  },
  {
    name: "Overdue return-to-work interview",
    weight: "8%",
    what: "A process gap worth following up.",
    how: "Count of approved sick spells that ended 3 or more days ago with no completed return-to-work interview (an interview without a completion date does not count). 2 or more fully contributes.",
  },
];

function MetricList({ rows }: { rows: Row[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.name} className="rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-medium">{r.name}</div>
            {r.weight ? (
              <div className="text-xs text-muted-foreground">Weight: {r.weight}</div>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            <span className="font-medium">What it means: </span>
            {r.what}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">How it's calculated: </span>
            {r.how}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function WellbeingMetricGuide({ showAttrition = false }: { showAttrition?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="h-4 w-4" aria-hidden="true" />
          How these numbers are calculated
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" className="w-full">
          <AccordionItem value="score">
            <AccordionTrigger className="text-sm">Wellbeing score (0 – 100)</AccordionTrigger>
            <AccordionContent className="space-y-3 text-sm">
              <p>
                A rolling <strong>90-day</strong> composite score built only from data the app
                already collects — no self-report is used for the number itself.{" "}
                <strong>Higher is better.</strong> If fewer than 10 of your rota sessions fall in
                the window, no score is given ("Not enough data") — missing data is never shown as
                good wellbeing. The window is the last 90 calendar days including today.
              </p>
              <p>
                Each of the drivers below is scaled 0 – 1 (0 = no concern, 1 = fully weighted
                concern), multiplied by its weight, then summed to give a total "harm" value. The
                score is <code className="rounded bg-muted px-1">round((1 − harm) × 100)</code>,
                clamped to 0 – 100.
              </p>
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="font-medium">Bands</div>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  <li>
                    <strong className="text-foreground">Thriving</strong> — 80 or above
                  </li>
                  <li>
                    <strong className="text-foreground">Steady</strong> — 65 – 79
                  </li>
                  <li>
                    <strong className="text-foreground">Strained</strong> — 45 – 64
                  </li>
                  <li>
                    <strong className="text-foreground">At risk</strong> — below 45
                  </li>
                </ul>
              </div>
              <MetricList rows={WELLBEING_ROWS} />
              <p className="text-xs text-muted-foreground">
                The weights above sum to 100% of the harm calculation and are hard-coded in{" "}
                <code>src/features/wellbeing/wellbeing-score.ts</code> — they aren't tuned per
                person.
              </p>
            </AccordionContent>
          </AccordionItem>

          {showAttrition ? (
            <AccordionItem value="attrition">
              <AccordionTrigger className="text-sm">
                Retention signal score (0 – 100)
              </AccordionTrigger>
              <AccordionContent className="space-y-3 text-sm">
                <p>
                  A transparent weighted rubric that adds up operational signals into a score out of
                  100. <strong>It is not a prediction or a probability</strong> of anyone leaving
                  and has not been validated against who actually leaves. Higher means more signals
                  are present.
                </p>
                <p>
                  Each factor is scaled 0 – 1, multiplied by its weight, then summed to give the
                  total, which is rounded to a whole number out of 100. The band is chosen from that
                  rounded number, so a displayed 25 is always "Watch". If the wellbeing score has
                  too little data, the row is shown as "Not assessed".
                </p>
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <div className="font-medium">Bands</div>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    <li>
                      <strong className="text-foreground">Low</strong> — under 25
                    </li>
                    <li>
                      <strong className="text-foreground">Watch</strong> — 25 – 44
                    </li>
                    <li>
                      <strong className="text-foreground">Elevated</strong> — 45 – 64
                    </li>
                    <li>
                      <strong className="text-foreground">High</strong> — 65 or above
                    </li>
                  </ul>
                </div>
                <MetricList rows={ATTRITION_ROWS} />
                <p className="text-xs text-muted-foreground">
                  The weights above sum to 100% and are hard-coded in{" "}
                  <code>src/lib/attrition-risk.ts</code>. Use the "Top drivers" column to see which
                  factors dominate for each person, as a starting point for a supportive
                  conversation.
                </p>
              </AccordionContent>
            </AccordionItem>
          ) : null}

          <AccordionItem value="privacy">
            <AccordionTrigger className="text-sm">
              Who can see this, and what it isn't
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                Personal wellbeing pages are visible only to the individual and to admins. The
                retention signal score is admin-only.
              </p>
              <p>
                Neither score is a clinical or HR judgement. They're a triage aid built from
                operational data — a low score is a prompt to have a supportive conversation, not a
                diagnosis, and must not be used for HR, performance or employment decisions.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
