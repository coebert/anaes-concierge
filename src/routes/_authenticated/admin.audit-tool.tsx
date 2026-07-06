import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  LabelList,
  Area,
  AreaChart,
} from "recharts";
import { Download, Database, AlertCircle, RotateCcw, Sparkles, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
// xlsx / jspdf / jspdf-autotable are large; lazy-loaded inside the
// download helpers below to keep them out of the SSR + initial client
// bundle (they previously caused build OOM).
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/_authenticated/admin/audit-tool")({
  component: AuditToolPage,
});

const SUGGESTIONS = [
  "Average weekly clinical hours per consultant over the last 12 weeks (excluding leave)",
  "Annual leave requests broken down by month for the current leave year",
  "Trainees with fewer than the target number of solo lists in the last 8 weeks",
  "Top 10 days with the most unfilled rota gaps in the last 3 months",
];

interface RunSqlOutput {
  title?: string;
  sql?: string;
  chart?: {
    type: "bar" | "line" | "pie";
    xKey: string;
    yKeys: string[];
    title?: string;
  } | null;
  rowCount?: number;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  rowsPreview?: Array<Record<string, unknown>>;
  error?: string;
}

interface ReportSection {
  heading: string;
  prose?: string;
  bullets?: string[];
  chart?: {
    type: "bar" | "line" | "pie" | "doughnut";
    title?: string;
    labels: string[];
    datasets: Array<{ label: string; data: number[] }>;
  };
  chartUrl?: string;
}

interface ReportOutput {
  title: string;
  executive_summary: string;
  key_findings: string[];
  sections: ReportSection[];
  recommendations?: string[];
  caveats?: string[];
  generatedAt?: string;
}


const STORAGE_KEY_PREFIX = "audit-tool:messages:";

function loadStoredMessages(userId: string | undefined): UIMessage[] {
  if (typeof window === "undefined" || !userId) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + userId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UIMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function AuditToolPage() {
  const { hasRole, user } = useAuth();
  const userId = user?.id;
  const storageKey = userId ? STORAGE_KEY_PREFIX + userId : null;

  const [resetKey, setResetKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/audit-tool",
        prepareSendMessagesRequest: async ({ messages, body }) => {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          const headers: Record<string, string> = {};
          if (token) headers.Authorization = `Bearer ${token}`;
          return { body: { messages, ...(body ?? {}) }, headers };
        },
      }),
    [],
  );

  // Lazy-load persisted messages so the conversation survives reloads & navigation.
  const initialMessages = useMemo(() => loadStoredMessages(userId), [userId]);

  const { messages, sendMessage, status, error, setMessages } = useChat({
    id: `audit-${userId ?? "anon"}-${resetKey}`,
    messages: initialMessages,
    transport,
    onError: (err) => {
      console.error(err);
      toast.error("Audit tool error", { description: err.message });
    },
  });

  const [input, setInput] = useState("");
  const isBusy = status === "submitted" || status === "streaming";

  // Persist messages to localStorage so prior Q&A is retained across sessions.
  useEffect(() => {
    if (!storageKey) return;
    try {
      if (messages.length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(messages));
      }
    } catch {
      // localStorage may be full or unavailable; ignore silently.
    }
  }, [messages, storageKey, status]);

  useEffect(() => {
    if (!isBusy) textareaRef.current?.focus();
  }, [isBusy, resetKey]);

  if (!hasRole("admin")) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        This tool is restricted to admin users.
      </div>
    );
  }

  const onSubmit = async ({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput("");
    await sendMessage({ text: trimmed });
  };

  const onReset = () => {
    setMessages([]);
    setInput("");
    if (storageKey) {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
    setResetKey((k) => k + 1);
  };

  // Collect all query results across the conversation for the right-hand report panel.
  const reports: Array<{ id: string; output: RunSqlOutput }> = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    m.parts.forEach((part, idx) => {
      const p = part as { type: string; output?: unknown };
      if (p.type === "tool-run_sql" && p.output && typeof p.output === "object") {
        reports.push({ id: `${m.id}-${idx}`, output: p.output as RunSqlOutput });
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" />
            AI Audit & Data Analysis
          </h1>
          <p className="text-sm text-muted-foreground">
            Describe what you want to know in plain English. The assistant will ask any
            clarifying questions, run read-only queries on the rota database, and present a
            report below.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => void sendMessage({
              text: "Please produce a professional audit report on this analysis using the generate_report tool. Run any additional queries you need first, then call generate_report with a clear title, executive summary, key findings as bullet points, sections with prose and charts where useful, and recommendations or caveats as appropriate.",
            })}
            disabled={isBusy || messages.length === 0}
          >
            <FileText className="mr-1.5 h-4 w-4" />
            Generate report
          </Button>
          <Button variant="outline" size="sm" onClick={onReset} disabled={messages.length === 0}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            New audit
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Chat panel */}
        <Card className="flex h-[calc(100vh-220px)] min-h-[500px] flex-col overflow-hidden">
          <CardHeader className="border-b py-3">
            <CardTitle className="text-sm font-medium">Conversation</CardTitle>
          </CardHeader>
          <Conversation className="flex-1">
            <ConversationContent>
              {messages.length === 0 ? (
                <div className="flex flex-col items-start gap-3 p-4">
                  <div className="text-sm text-muted-foreground">
                    Try one of these to get started:
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => void sendMessage({ text: s })}
                        className="rounded-md border bg-background px-3 py-2 text-left text-xs hover:bg-accent"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => <ChatBubble key={m.id} message={m} />)
              )}
              {status === "submitted" && (
                <div className="px-4 py-2">
                  <Shimmer>Thinking…</Shimmer>
                </div>
              )}
              {error && (
                <div className="m-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 break-words">{error.message}</div>
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          <div className="border-t p-3">
            <PromptInput onSubmit={onSubmit}>
              <PromptInputTextarea
                ref={textareaRef as never}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Describe the audit or data analysis you want…"
                disabled={isBusy}
              />
              <PromptInputFooter className="justify-end">
                <PromptInputSubmit
                  status={status}
                  disabled={!input.trim() && !isBusy}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </Card>

        {/* Report panel */}
        <div className="space-y-4">
          {reports.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-muted-foreground">
                <Database className="h-8 w-8" />
                <div>Report results will appear here once the assistant runs a query.</div>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {reports.length} {reports.length === 1 ? "report" : "reports"} in this conversation
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Export all
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel className="text-xs">Combined export</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => downloadAllExcel(reports)}>
                      Excel workbook (.xlsx)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => downloadAllPdf(reports)}>
                      PDF document (.pdf)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {reports.map((r) => <ReportCard key={r.id} output={r.output} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}


function ChatBubble({ message }: { message: UIMessage }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          const p = part as { type: string; text?: string; state?: string; input?: unknown };
          if (p.type === "text") {
            return <MessageResponse key={i}>{p.text ?? ""}</MessageResponse>;
          }
          if (p.type === "tool-describe_schema") {
            return (
              <div key={i} className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database className="h-3 w-3" />
                <span>Inspecting schema</span>
                {p.state && p.state !== "output-available" && (
                  <span className="italic">({p.state})</span>
                )}
              </div>
            );
          }
          if (p.type === "tool-run_sql") {
            const input = (p.input ?? {}) as { title?: string };
            return (
              <div key={i} className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database className="h-3 w-3" />
                <span>Ran query:</span>
                <Badge variant="secondary" className="text-[10px]">
                  {input.title ?? "query"}
                </Badge>
                {p.state && p.state !== "output-available" && (
                  <span className="italic">({p.state})</span>
                )}
              </div>
            );
          }
          if (p.type === "tool-generate_report") {
            const out = (p as { output?: unknown }).output as ReportOutput | undefined;
            if (p.state && p.state !== "output-available") {
              return (
                <div key={i} className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  <span>Drafting report…</span>
                </div>
              );
            }
            if (!out) return null;
            return <ReportDocument key={i} report={out} />;
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}

function ReportDocument({ report }: { report: ReportOutput }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b bg-muted/40 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <FileText className="h-3 w-3" />
            Audit report
          </div>
          <h2 className="mt-1 text-lg font-semibold leading-tight text-foreground">
            {report.title}
          </h2>
          {report.generatedAt && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Generated {new Date(report.generatedAt).toLocaleString()}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void downloadReportPdf(report)}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          PDF
        </Button>
      </div>

      <div className="space-y-5 px-5 py-4 text-sm">
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Executive summary
          </h3>
          <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
            <ReactMarkdown>{report.executive_summary}</ReactMarkdown>
          </div>
        </section>

        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Key findings
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-foreground">
            {report.key_findings.map((f, i) => (
              <li key={i} className="leading-snug">
                <span className="prose prose-sm inline max-w-none dark:prose-invert">
                  <ReactMarkdown
                    components={{ p: ({ children }) => <>{children}</> }}
                  >
                    {f}
                  </ReactMarkdown>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {report.sections.map((s, i) => (
          <section key={i}>
            <h3 className="mb-1.5 text-sm font-semibold text-foreground">
              {s.heading}
            </h3>
            {s.prose && (
              <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                <ReactMarkdown>{s.prose}</ReactMarkdown>
              </div>
            )}
            {s.bullets && s.bullets.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground">
                {s.bullets.map((b, j) => (
                  <li key={j} className="leading-snug">{b}</li>
                ))}
              </ul>
            )}
            {s.chartUrl && (
              <div className="mt-3 overflow-hidden rounded-md border bg-white p-2">
                <img
                  src={s.chartUrl}
                  alt={s.chart?.title ?? s.heading}
                  className="mx-auto block h-auto max-w-full"
                  loading="lazy"
                />
              </div>
            )}
          </section>
        ))}

        {report.recommendations && report.recommendations.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recommendations
            </h3>
            <ul className="list-disc space-y-1 pl-5 text-foreground">
              {report.recommendations.map((r, i) => (
                <li key={i} className="leading-snug">{r}</li>
              ))}
            </ul>
          </section>
        )}

        {report.caveats && report.caveats.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Caveats &amp; assumptions
            </h3>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {report.caveats.map((c, i) => (
                <li key={i} className="leading-snug">{c}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function downloadReportPdf(report: ReportOutput) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 48;
  const contentWidth = pageWidth - marginX * 2;
  let y = 56;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - 48) {
      doc.addPage();
      y = 56;
    }
  };

  const writeWrapped = (
    text: string,
    opts: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {},
  ) => {
    const size = opts.size ?? 10.5;
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    const c = opts.color ?? [30, 30, 30];
    doc.setTextColor(c[0], c[1], c[2]);
    const lines = doc.splitTextToSize(text, contentWidth);
    const lineHeight = size * 1.35;
    ensureSpace(lines.length * lineHeight);
    doc.text(lines, marginX, y);
    y += lines.length * lineHeight + (opts.gap ?? 4);
  };

  const writeHeading = (text: string, level: 1 | 2 | 3) => {
    const sizes = { 1: 20, 2: 13, 3: 11 } as const;
    y += level === 1 ? 0 : 6;
    writeWrapped(text, {
      size: sizes[level],
      bold: true,
      color: level === 1 ? [15, 23, 42] : [51, 65, 85],
      gap: level === 1 ? 10 : 6,
    });
  };

  const writeBullets = (items: string[], muted = false) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    const c2: [number, number, number] = muted ? [100, 116, 139] : [30, 30, 30];
    doc.setTextColor(c2[0], c2[1], c2[2]);
    const lineHeight = 14;
    for (const item of items) {
      const lines = doc.splitTextToSize(item, contentWidth - 16);
      ensureSpace(lines.length * lineHeight);
      doc.text("•", marginX, y);
      doc.text(lines, marginX + 14, y);
      y += lines.length * lineHeight + 2;
    }
    y += 4;
  };

  // Title block
  writeHeading(report.title, 1);
  if (report.generatedAt) {
    writeWrapped(`Generated ${new Date(report.generatedAt).toLocaleString()}`, {
      size: 9,
      color: [120, 120, 120],
      gap: 14,
    });
  }

  writeHeading("Executive summary", 2);
  writeWrapped(report.executive_summary);

  writeHeading("Key findings", 2);
  writeBullets(report.key_findings);

  for (const s of report.sections) {
    writeHeading(s.heading, 3);
    if (s.prose) writeWrapped(s.prose);
    if (s.bullets && s.bullets.length) writeBullets(s.bullets);
    if (s.chartUrl) {
      const dataUrl = await fetchImageAsDataUrl(s.chartUrl);
      if (dataUrl) {
        // QuickChart returns 720x380 by default; preserve aspect ratio.
        const imgWidth = contentWidth;
        const imgHeight = imgWidth * (380 / 720);
        ensureSpace(imgHeight + 8);
        try {
          doc.addImage(dataUrl, "PNG", marginX, y, imgWidth, imgHeight);
          y += imgHeight + 10;
        } catch {
          writeWrapped("[Chart could not be embedded]", { size: 9, color: [180, 0, 0] });
        }
      }
    }
  }

  if (report.recommendations && report.recommendations.length) {
    writeHeading("Recommendations", 2);
    writeBullets(report.recommendations);
  }

  if (report.caveats && report.caveats.length) {
    writeHeading("Caveats & assumptions", 2);
    writeBullets(report.caveats, true);
  }

  const filename = report.title.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80) || "audit-report";
  doc.save(`${filename}.pdf`);
}


function ReportCard({ output }: { output: RunSqlOutput }) {
  if (output.error) {
    return (
      <Card className="border-destructive/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{output.title ?? "Query failed"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-start gap-2 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 break-words">{output.error}</div>
          </div>
          {output.sql && (
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[11px]">
              {output.sql}
            </pre>
          )}
        </CardContent>
      </Card>
    );
  }

  const rows = output.rows ?? output.rowsPreview ?? [];
  const columns = output.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const rowCount = output.rowCount ?? rows.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">{output.title ?? "Query result"}</CardTitle>
            <div className="text-xs text-muted-foreground">
              {rowCount.toLocaleString()} {rowCount === 1 ? "row" : "rows"}
              {rowCount >= 5000 && " (capped at 5000)"}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={rows.length === 0}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => downloadCsv(rows, columns, output.title ?? "report")}>
                CSV (.csv)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadExcel(rows, columns, output.title ?? "report")}>
                Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadPdf(rows, columns, output.title ?? "report", output.sql)}>
                PDF (.pdf)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {output.chart && rows.length > 0 && (
          <ChartView chart={output.chart} rows={rows} />
        )}
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            No rows returned.
          </div>
        ) : (
          <div className="max-h-[400px] overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-muted">
                <TableRow>
                  {columns.map((c) => (
                    <TableHead key={c} className="whitespace-nowrap text-xs">
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 200).map((row, i) => (
                  <TableRow key={i}>
                    {columns.map((c) => (
                      <TableCell key={c} className="whitespace-nowrap text-xs">
                        {formatCell(row[c])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length > 200 && (
              <div className="border-t bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">
                Showing first 200 of {rows.length.toLocaleString()} rows — download CSV for full data.
              </div>
            )}
          </div>
        )}
        {output.sql && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              View SQL
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-[11px]">
              {output.sql}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

// A wide, perceptually-distinct categorical palette so multi-series charts
// stay legible even with 8+ series. Falls through to the theme's chart tokens
// for the first five so colors track the design system in light/dark mode.
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "oklch(0.62 0.21 145)", // emerald
  "oklch(0.65 0.19 25)",  // coral
  "oklch(0.58 0.22 295)", // violet
  "oklch(0.72 0.16 90)",  // amber
  "oklch(0.55 0.18 220)", // azure
  "oklch(0.6 0.2 340)",   // magenta
  "oklch(0.68 0.15 180)", // teal
];

function colorAt(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length];
}

function formatTick(v: unknown): string {
  if (typeof v === "number") {
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
    if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1) + "k";
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  const s = String(v ?? "");
  return s.length > 16 ? s.slice(0, 15) + "…" : s;
}

function ChartView({
  chart,
  rows,
}: {
  chart: NonNullable<RunSqlOutput["chart"]>;
  rows: Array<Record<string, unknown>>;
}) {
  const config = Object.fromEntries(
    chart.yKeys.map((k, i) => [k, { label: k, color: colorAt(i) }]),
  );
  // Coerce numeric strings to numbers for the y-axes.
  const data = rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of chart.yKeys) {
      const v = r[k];
      if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
        out[k] = Number(v);
      }
    }
    return out;
  });

  const isLong = data.length > 12;
  const chartHeight = chart.type === "pie" ? 320 : 300;

  return (
    <div className="space-y-2">
      {chart.title && (
        <div className="text-sm font-medium text-foreground">{chart.title}</div>
      )}
      <ChartContainer config={config} className="w-full" style={{ height: chartHeight }}>
        {chart.type === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: isLong ? 48 : 16 }}>
            <defs>
              {chart.yKeys.map((k, i) => (
                <linearGradient key={k} id={`bar-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colorAt(i)} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={colorAt(i)} stopOpacity={0.55} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey={chart.xKey}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              angle={isLong ? -35 : 0}
              textAnchor={isLong ? "end" : "middle"}
              interval={isLong ? "preserveStartEnd" : 0}
              height={isLong ? 60 : 30}
              tickFormatter={(v) => formatTick(v)}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => formatTick(v)}
              width={48}
            />
            <ChartTooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} content={<ChartTooltipContent />} />
            {chart.yKeys.length > 1 && (
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" />
            )}
            {chart.yKeys.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                fill={`url(#bar-grad-${i})`}
                stroke={colorAt(i)}
                strokeWidth={1}
                radius={[6, 6, 0, 0]}
                maxBarSize={56}
              />
            ))}
          </BarChart>
        ) : chart.type === "line" ? (
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: isLong ? 48 : 16 }}>
            <defs>
              {chart.yKeys.map((k, i) => (
                <linearGradient key={k} id={`line-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colorAt(i)} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={colorAt(i)} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey={chart.xKey}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              angle={isLong ? -35 : 0}
              textAnchor={isLong ? "end" : "middle"}
              interval={isLong ? "preserveStartEnd" : 0}
              height={isLong ? 60 : 30}
              tickFormatter={(v) => formatTick(v)}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => formatTick(v)}
              width={48}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {chart.yKeys.length > 1 && (
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" />
            )}
            {chart.yKeys.map((k, i) => (
              <Area
                key={k}
                type="monotone"
                dataKey={k}
                stroke={colorAt(i)}
                strokeWidth={2.25}
                fill={`url(#line-grad-${i})`}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "hsl(var(--background))" }}
                dot={data.length <= 30 ? { r: 3, strokeWidth: 1.5, stroke: "hsl(var(--background))", fill: colorAt(i) } : false}
              />
            ))}
          </AreaChart>
        ) : (
          <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <ChartTooltip content={<ChartTooltipContent nameKey={chart.xKey} />} />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              iconType="circle"
              layout="vertical"
              align="right"
              verticalAlign="middle"
            />
            <Pie
              data={data}
              dataKey={chart.yKeys[0]}
              nameKey={chart.xKey}
              innerRadius={55}
              outerRadius={110}
              paddingAngle={2}
              stroke="hsl(var(--background))"
              strokeWidth={2}
              label={(entry: { percent?: number }) =>
                entry.percent && entry.percent > 0.04 ? `${(entry.percent * 100).toFixed(0)}%` : ""
              }
              labelLine={false}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={colorAt(i)} />
              ))}
              <LabelList dataKey={chart.xKey} position="outside" style={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
            </Pie>
          </PieChart>
        )}
      </ChartContainer>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function downloadCsv(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  filename: string,
) {
  const escape = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map(escape).join(",");
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(",")).join("\n");
  const csv = header + "\n" + body;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename.replace(/[^a-z0-9-_]+/gi, "_")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "report";
}

function rowsToAOA(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): unknown[][] {
  const header = columns;
  const body = rows.map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v == null) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    }),
  );
  return [header, ...body];
}

async function downloadExcel(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  filename: string,
) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rowsToAOA(rows, columns));
  XLSX.utils.book_append_sheet(wb, ws, safeName(filename).slice(0, 31));
  XLSX.writeFile(wb, `${safeName(filename)}.xlsx`);
}

async function downloadAllExcel(reports: Array<{ id: string; output: RunSqlOutput }>) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  reports.forEach((r, i) => {
    const rows = r.output.rows ?? r.output.rowsPreview ?? [];
    const columns =
      r.output.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
    const aoa =
      rows.length === 0
        ? [[r.output.error ?? "No rows returned."]]
        : rowsToAOA(rows, columns);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Excel sheet names: max 31 chars, no []:*?/\
    let base =
      (r.output.title ?? `Report ${i + 1}`)
        .replace(/[[\]:*?/\\]/g, "")
        .slice(0, 28) || `Report ${i + 1}`;
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base} ${n++}`.slice(0, 31);
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  XLSX.writeFile(wb, `audit-reports-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

async function downloadPdf(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  filename: string,
  sql?: string,
) {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text(filename, 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `Generated ${new Date().toLocaleString()} — ${rows.length} ${rows.length === 1 ? "row" : "rows"}`,
    40,
    56,
  );
  doc.setTextColor(0);
  autoTable(doc, {
    startY: 72,
    head: [columns],
    body: rows.map((r) =>
      columns.map((c) => {
        const v = r[c];
        if (v == null) return "";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      }),
    ),
    styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [60, 60, 60] },
    margin: { left: 40, right: 40 },
  });
  if (sql) {
    const lastY =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
        ?.finalY ?? 72;
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("SQL:", 40, lastY + 20);
    const wrapped = doc.splitTextToSize(sql, doc.internal.pageSize.getWidth() - 80);
    doc.text(wrapped, 40, lastY + 32);
  }
  doc.save(`${safeName(filename)}.pdf`);
}

async function downloadAllPdf(reports: Array<{ id: string; output: RunSqlOutput }>) {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  doc.setFontSize(16);
  doc.text("Audit Reports", 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, 56);
  doc.setTextColor(0);

  reports.forEach((r, i) => {
    if (i > 0) doc.addPage();
    const startY = i === 0 ? 80 : 40;
    const rows = r.output.rows ?? r.output.rowsPreview ?? [];
    const columns =
      r.output.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
    doc.setFontSize(12);
    doc.text(r.output.title ?? `Report ${i + 1}`, 40, startY);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(
      `${rows.length} ${rows.length === 1 ? "row" : "rows"}`,
      40,
      startY + 14,
    );
    doc.setTextColor(0);
    if (r.output.error) {
      doc.setTextColor(180, 0, 0);
      doc.text(r.output.error, 40, startY + 32);
      doc.setTextColor(0);
      return;
    }
    autoTable(doc, {
      startY: startY + 22,
      head: [columns],
      body: rows.map((row) =>
        columns.map((c) => {
          const v = row[c];
          if (v == null) return "";
          if (typeof v === "object") return JSON.stringify(v);
          return String(v);
        }),
      ),
      styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: [60, 60, 60] },
      margin: { left: 40, right: 40 },
    });
  });

  doc.save(`audit-reports-${new Date().toISOString().slice(0, 10)}.pdf`);
}
