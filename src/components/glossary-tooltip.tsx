"use client";

import * as React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { lookupGlossary, GLOSSARY } from "@/lib/glossary";
import { HelpCircle } from "lucide-react";
import { Link } from "@tanstack/react-router";

interface GlossaryTermProps {
  children: string;
  className?: string;
}

/** Wrap a single glossary term with a tooltip showing its definition. */
export function GlossaryTerm({ children, className }: GlossaryTermProps) {
  const entry = lookupGlossary(children);
  if (!entry) return <>{children}</>;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`cursor-help border-b border-dotted border-primary/60 ${className ?? ""}`}
            aria-describedby={`glossary-${entry.acronym}`}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-xs space-y-1 bg-popover text-popover-foreground border border-border shadow-md"
        >
          <div className="font-semibold text-sm">
            {entry.acronym ? `${entry.acronym} — ${entry.term}` : entry.term}
          </div>
          <p className="text-xs leading-relaxed">{entry.definition}</p>
          {entry.related && entry.related.length > 0 && (
            <div className="text-[10px] text-muted-foreground pt-1 border-t border-border">
              See also:{" "}
              {entry.related.map((r, i) => (
                <React.Fragment key={r}>
                  {i > 0 && ", "}
                  <GlossaryTerm>{r}</GlossaryTerm>
                </React.Fragment>
              ))}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Scan plain text for known glossary terms and wrap them automatically. */
export function GlossaryText({ children }: { children: string }) {
  // Sort acronyms by length descending so longer matches win (e.g. "solo list" before "solo")
  const patterns = React.useMemo(() => {
    const entries = Object.entries(GLOSSARY);
    // Build regex that matches any acronym (word boundaries)
    const acronyms = entries
      .map(([, e]) => e.acronym)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return { acronyms };
  }, []);

  if (!patterns.acronyms.length) return <>{children}</>;

  // Build a regex that matches any acronym with word boundaries
  const escaped = patterns.acronyms.map((a) =>
    a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const regex = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(children)) !== null) {
    // Push text before match
    if (match.index > lastIndex) {
      parts.push(children.slice(lastIndex, match.index));
    }
    // Push wrapped match
    parts.push(
      <GlossaryTerm key={`${match.index}-${match[1]}`}>
        {match[1]}
      </GlossaryTerm>
    );
    lastIndex = regex.lastIndex;
  }
  // Push remaining text
  if (lastIndex < children.length) {
    parts.push(children.slice(lastIndex));
  }

  return <>{parts}</>;
}

/** Small inline glossary-link icon for use next to headings or labels. */
export function GlossaryLink({ term }: { term?: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/glossary"
            className="inline-flex items-center text-muted-foreground hover:text-primary transition-colors"
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {term ? `Glossary: ${term}` : "Open glossary"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
