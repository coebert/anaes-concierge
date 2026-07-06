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
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            AI Audit &amp; Data Analysis
          </span>
        }
        description="Describe what you want to know in plain English. The assistant will ask any clarifying questions, run read-only queries on the rota database, and present a report below."
        actions={
          <>
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
          </>
        }
      />

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
