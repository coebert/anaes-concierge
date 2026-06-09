import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GLOSSARY, type GlossaryEntry } from "@/lib/glossary";
import { BookOpen } from "lucide-react";

export const Route = createFileRoute("/_authenticated/glossary")({
  component: GlossaryPage,
  head: () => ({
    meta: [
      { title: "Glossary — Salisbury Anaesthetics Rota" },
      {
        name: "description",
        content: "Glossary of rota and anaesthetic terms used in the Salisbury DGH anaesthetics department.",
      },
    ],
  }),
});

const CATEGORY_LABEL: Record<GlossaryEntry["category"], string> = {
  clinical: "Clinical",
  administrative: "Administrative",
  rota: "Rota",
  theatre: "Theatre",
};

const CATEGORY_ORDER: GlossaryEntry["category"][] = [
  "administrative",
  "clinical",
  "theatre",
  "rota",
];

function GlossaryPage() {
  const byCategory = GLOSSARY.reduce<Map<GlossaryEntry["category"], GlossaryEntry[]>>(
    (map, entry) => {
      const arr = map.get(entry.category) ?? [];
      arr.push(entry);
      map.set(entry.category, arr);
      return map;
    },
    new Map()
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BookOpen className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Glossary</h1>
          <p className="text-sm text-muted-foreground">
            Terms and abbreviations used throughout the rota and anaesthetic services at Salisbury DGH.
          </p>
        </div>
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const entries = byCategory.get(cat);
        if (!entries || entries.length === 0) return null;
        return (
          <Card key={cat}>
            <CardHeader>
              <CardTitle className="text-base">{CATEGORY_LABEL[cat]}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {entries.map((entry) => (
                <div key={entry.term} className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {entry.acronym && (
                      <Badge variant="secondary" className="text-xs font-mono">
                        {entry.acronym}
                      </Badge>
                    )}
                    <span className="font-medium text-sm">{entry.term}</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {entry.definition}
                  </p>
                  {entry.related && entry.related.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap text-xs">
                      <span className="text-muted-foreground">See also:</span>
                      {entry.related.map((r) => (
                        <Badge key={r} variant="outline" className="text-[10px]">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      <p className="text-xs text-muted-foreground text-center">
        Hover over any highlighted term elsewhere in the app to see a quick definition, or{" "}
        <Link to="/glossary" className="underline hover:text-foreground">
          return to this page
        </Link>{" "}
        for the full list.
      </p>
    </div>
  );
}
