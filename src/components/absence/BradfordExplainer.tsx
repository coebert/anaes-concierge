import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Info } from "lucide-react";
import { BAND_THRESHOLDS } from "@/lib/bradford-factor";

/**
 * Plain-English explainer for the Bradford Factor shown on the admin
 * absence page. Band thresholds and the score formula are read from
 * `@/lib/bradford-factor` so any change to the calibration flows
 * through automatically.
 */
export function BradfordExplainer() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="h-4 w-4" aria-hidden="true" />
          About the Bradford Factor
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" className="w-full">
          <AccordionItem value="why">
            <AccordionTrigger className="text-sm">
              Why this score matters
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <p>
                The Bradford Factor is the attendance-management score used
                widely across NHS trusts. It exists because a{" "}
                <strong>total-days-lost</strong> figure hides the pattern
                that most affects a rota: <strong>frequent short spells</strong>{" "}
                are far more disruptive to service delivery — and often more
                indicative of an underlying wellbeing or work-related issue —
                than a single long absence of the same total length.
              </p>
              <p>
                Two people can lose the same 10 days in a year and score
                very differently:
              </p>
              <ul className="ml-5 list-disc space-y-1 text-muted-foreground">
                <li>
                  1 spell × 10 days ={" "}
                  <span className="font-mono text-foreground">1² × 10 = 10</span>{" "}
                  → Green.
                </li>
                <li>
                  5 spells × 2 days ={" "}
                  <span className="font-mono text-foreground">5² × 10 = 250</span>{" "}
                  → Red (formal attendance review).
                </li>
              </ul>
              <p className="text-muted-foreground">
                The score is a triage prompt, not a disciplinary judgement.
                A high score should trigger a conversation about what's
                driving the pattern — not an automatic sanction.
              </p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="how">
            <AccordionTrigger className="text-sm">
              How the score is calculated
            </AccordionTrigger>
            <AccordionContent className="space-y-3 text-sm">
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="text-center font-mono text-base">
                  B = S² × D
                </div>
                <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground">
                  <li>
                    <strong className="text-foreground">S</strong> = number
                    of distinct sickness <strong>spells</strong> in the last
                    12 months (each contiguous run of sick days = 1 spell).
                  </li>
                  <li>
                    <strong className="text-foreground">D</strong> = total{" "}
                    <strong>days lost</strong> to sickness in the same
                    12-month window.
                  </li>
                </ul>
              </div>
              <p>
                Only <strong>approved sick-leave</strong> entries count.
                Annual leave, study leave and unapproved requests never
                affect the score. Half-day starts or ends count as 0.5
                rather than a full day, so genuinely short absences don't
                inflate the days-lost figure.
              </p>
              <p>
                The window is a rolling 12 months ending today, so old
                spells drop off automatically — the score reflects recent
                pattern, not historic total.
              </p>
              <p className="text-xs text-muted-foreground">
                Formula and windowing are implemented in{" "}
                <code>src/lib/bradford-factor.ts</code>.
              </p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="bands">
            <AccordionTrigger className="text-sm">
              What the bands mean
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm">
              <p>
                Bands are the NHS-standard calibration used across most
                trusts. Individual trusts may tune them, so the thresholds
                are configurable in code rather than hard-coded across the
                app.
              </p>
              <ul className="space-y-2">
                <li className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">
                    {BAND_THRESHOLDS.green.label} — 0 to{" "}
                    {BAND_THRESHOLDS.amber.min - 1}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {BAND_THRESHOLDS.green.action}.
                  </div>
                </li>
                <li className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">
                    {BAND_THRESHOLDS.amber.label} —{" "}
                    {BAND_THRESHOLDS.amber.min} to{" "}
                    {BAND_THRESHOLDS.red.min - 1}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {BAND_THRESHOLDS.amber.action}. Typically a supportive
                    check-in — is there a rota, health or workload issue
                    to address?
                  </div>
                </li>
                <li className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">
                    {BAND_THRESHOLDS.red.label} —{" "}
                    {BAND_THRESHOLDS.red.min} to{" "}
                    {BAND_THRESHOLDS.critical.min - 1}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {BAND_THRESHOLDS.red.action}. Occupational-health
                    referral is often appropriate at this point.
                  </div>
                </li>
                <li className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">
                    {BAND_THRESHOLDS.critical.label} —{" "}
                    {BAND_THRESHOLDS.critical.min}+
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {BAND_THRESHOLDS.critical.action}.
                  </div>
                </li>
              </ul>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="limits">
            <AccordionTrigger className="text-sm">
              Limitations to keep in mind
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The score is deliberately blunt. It weights frequency far
                more heavily than duration, which is the point — but it
                also means a single chronic condition causing regular
                short absences will look identical to unrelated one-off
                spells.
              </p>
              <p>
                Pregnancy-related absence, disability-related absence and
                absences covered by a reasonable-adjustment agreement
                should be excluded from formal action based on Bradford —
                that judgement sits with the reviewer, not the score.
              </p>
              <p>
                Use the score to <em>find</em> the people to talk to.
                Use the conversation to decide what to do next.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
