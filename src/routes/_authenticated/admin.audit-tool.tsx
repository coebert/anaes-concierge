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
} from "recharts";
import { Download, Database, AlertCircle, RotateCcw, Sparkles } from "lucide-react";
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

function AuditToolPage() {
  const { hasRole } = useAuth();
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

  const { messages, sendMessage, status, error, setMessages } = useChat({
    id: `audit-${resetKey}`,
    transport,
    onError: (err) => {
      console.error(err);
      toast.error("Audit tool error", { description: err.message });
    },
  });

  const [input, setInput] = useState("");
  const isBusy = status === "submitted" || status === "streaming";

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
        <Button variant="outline" size="sm" onClick={onReset} disabled={messages.length === 0}>
          <RotateCcw className="mr-1.5 h-4 w-4" />
          New audit
        </Button>
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
            reports.map((r) => <ReportCard key={r.id} output={r.output} />)
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
          return null;
        })}
      </MessageContent>
    </Message>
  );
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(rows, columns, output.title ?? "report")}
            disabled={rows.length === 0}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            CSV
          </Button>
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

const CHART_COLORS = [
  "hsl(var(--chart-1, 220 70% 50%))",
  "hsl(var(--chart-2, 160 60% 45%))",
  "hsl(var(--chart-3, 30 80% 55%))",
  "hsl(var(--chart-4, 280 65% 60%))",
  "hsl(var(--chart-5, 0 70% 55%))",
];

function ChartView({
  chart,
  rows,
}: {
  chart: NonNullable<RunSqlOutput["chart"]>;
  rows: Array<Record<string, unknown>>;
}) {
  const config = Object.fromEntries(
    chart.yKeys.map((k, i) => [k, { label: k, color: CHART_COLORS[i % CHART_COLORS.length] }]),
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

  return (
    <ChartContainer config={config} className="h-[260px] w-full">
      {chart.type === "bar" ? (
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {chart.yKeys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </BarChart>
      ) : chart.type === "line" ? (
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {chart.yKeys.map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      ) : (
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent />} />
          <Pie
            data={data}
            dataKey={chart.yKeys[0]}
            nameKey={chart.xKey}
            outerRadius={90}
            label
          >
            {data.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      )}
    </ChartContainer>
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
