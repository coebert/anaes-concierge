import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import { toast } from "sonner";
import { formatDateGB } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  OUTCOME_LABEL,
  STATUS_LABEL,
  type ExceptionOutcome,
  type ExceptionReport,
  type ExceptionStatus,
} from "@/features/exceptions/types";
import { AlertTriangle, Clock, MessageSquare, ChevronDown, ChevronRight } from "lucide-react";

type Comment = {
  id: string;
  report_id: string;
  author_id: string;
  body: string;
  created_at: string;
  author_name?: string | null;
};

export function ExceptionCard({
  report,
  traineeName,
  responderName,
  canRespond,
  onChange,
}: {
  report: ExceptionReport;
  traineeName?: string | null;
  responderName?: string | null;
  canRespond: boolean;
  onChange: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [outcome, setOutcome] = useState<ExceptionOutcome | "">(report.outcome ?? "");
  const [outcomeNote, setOutcomeNote] = useState(report.outcome_note ?? "");
  const [busy, setBusy] = useState(false);

  const isOwn = user?.id === report.trainee_id;
  const isOpenStatus = !["resolved", "withdrawn"].includes(report.status);

  const dueDate = new Date(report.due_by);
  const overdue = isOpenStatus && dueDate.getTime() < Date.now();
  const dueRel = relativeTime(dueDate);

  const loadComments = async () => {
    const { data } = await supabase
      .from("exception_report_comments")
      .select("id, report_id, author_id, body, created_at, profiles:author_id(full_name)")
      .eq("report_id", report.id)
      .order("created_at", { ascending: true });
    setComments(
      (data ?? []).map((c: {
        id: string;
        report_id: string;
        author_id: string;
        body: string;
        created_at: string;
        profiles: { full_name: string | null } | null;
      }) => ({
        id: c.id,
        report_id: c.report_id,
        author_id: c.author_id,
        body: c.body,
        created_at: c.created_at,
        author_name: c.profiles?.full_name ?? null,
      })),
    );
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) loadComments();
  };

  const postComment = async () => {
    if (!user || commentBody.trim().length === 0) return;
    setBusy(true);
    const { error } = await supabase.from("exception_report_comments").insert({
      report_id: report.id,
      author_id: user.id,
      body: commentBody.trim(),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setCommentBody("");
    loadComments();
  };

  const setStatus = async (next: ExceptionStatus) => {
    if (!user) return;
    setBusy(true);
    const patch: {
      status: ExceptionStatus;
      acknowledged_at?: string;
      responder_id?: string;
      resolved_at?: string;
      outcome?: ExceptionOutcome;
      outcome_note?: string;
    } = { status: next };
    if (next === "acknowledged" && !report.acknowledged_at) {
      patch.acknowledged_at = new Date().toISOString();
      patch.responder_id = user.id;
    }
    if (next === "resolved") {
      patch.resolved_at = new Date().toISOString();
      if (!report.responder_id) patch.responder_id = user.id;
      if (outcome) patch.outcome = outcome;
      if (outcomeNote.trim()) patch.outcome_note = outcomeNote.trim();
      if (!outcome) {
        toast.error("Choose an outcome before marking resolved.");
        setBusy(false);
        return;
      }
    }
    const { error } = await supabase
      .from("exception_reports")
      .update(patch)
      .eq("id", report.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Marked ${STATUS_LABEL[next].toLowerCase()}`);
    invalidateWellbeing(qc);
    onChange();
  };

  const withdraw = async () => {
    if (!confirm("Withdraw this exception report? It will be closed with no further action.")) return;
    setBusy(true);
    const { error } = await supabase
      .from("exception_reports")
      .update({ status: "withdrawn" })
      .eq("id", report.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    invalidateWellbeing(qc);
    onChange();
  };

  return (
    <Card className={overdue ? "border-destructive/50" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <button
              onClick={toggle}
              className="flex items-center gap-2 text-left font-medium hover:underline"
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <span>{CATEGORY_LABEL[report.category]}</span>
              {report.immediate_safety_concern && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" /> Safety
                </Badge>
              )}
            </button>
            <div className="mt-1 text-xs text-muted-foreground">
              {traineeName && <span className="mr-2">{traineeName}</span>}
              Event {formatDateGB(report.event_date)}
              {report.event_session && ` · ${report.event_session.toUpperCase()}`}
              {report.hours_worked_extra != null && ` · +${report.hours_worked_extra}h worked`}
              {report.rest_missed_hours != null && ` · ${report.rest_missed_hours}h rest missed`}
              <span className="mx-2">·</span>
              Submitted {formatDateGB(report.created_at.slice(0, 10))}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusBadge status={report.status} />
            {isOpenStatus && (
              <span
                className={`flex items-center gap-1 text-xs ${overdue ? "text-destructive" : "text-muted-foreground"}`}
              >
                <Clock className="h-3 w-3" />
                {overdue ? `Overdue ${dueRel}` : `Due ${dueRel}`}
              </span>
            )}
            {report.outcome && (
              <Badge variant="outline">{OUTCOME_LABEL[report.outcome]}</Badge>
            )}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4 border-t pt-4">
          <p className="whitespace-pre-wrap text-sm">{report.description}</p>

          {report.outcome_note && (
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Outcome note {responderName ? `— ${responderName}` : ""}
              </div>
              {report.outcome_note}
            </div>
          )}

          {canRespond && isOpenStatus && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">Responder actions</div>
              <div className="flex flex-wrap gap-2">
                {report.status === "submitted" && (
                  <Button size="sm" variant="secondary" onClick={() => setStatus("acknowledged")} disabled={busy}>
                    Acknowledge
                  </Button>
                )}
                {report.status !== "under_review" && (
                  <Button size="sm" variant="secondary" onClick={() => setStatus("under_review")} disabled={busy}>
                    Mark under review
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setStatus("escalated")} disabled={busy}>
                  Escalate to Guardian
                </Button>
              </div>
              <div className="grid gap-2 pt-2 sm:grid-cols-2">
                <Select value={outcome} onValueChange={(v) => setOutcome(v as ExceptionOutcome)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose outcome…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(OUTCOME_LABEL) as ExceptionOutcome[]).map((k) => (
                      <SelectItem key={k} value={k}>{OUTCOME_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={() => setStatus("resolved")} disabled={busy}>
                  Resolve
                </Button>
              </div>
              <Textarea
                rows={2}
                placeholder="Outcome note (visible to the trainee)"
                value={outcomeNote}
                onChange={(e) => setOutcomeNote(e.target.value)}
              />
            </div>
          )}

          {isOwn && report.status === "submitted" && (
            <div>
              <Button size="sm" variant="ghost" onClick={withdraw} disabled={busy}>
                Withdraw
              </Button>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center gap-1 text-sm font-medium">
              <MessageSquare className="h-4 w-4" />
              Discussion ({comments.length})
            </div>
            <div className="space-y-2">
              {comments.map((c) => (
                <div key={c.id} className="rounded-md border p-2 text-sm">
                  <div className="mb-1 text-xs text-muted-foreground">
                    {c.author_name ?? "Unknown"} · {formatDateGB(c.created_at.slice(0, 10))}
                  </div>
                  <div className="whitespace-pre-wrap">{c.body}</div>
                </div>
              ))}
              {comments.length === 0 && (
                <p className="text-xs text-muted-foreground">No comments yet.</p>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <Textarea
                rows={2}
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Add a comment…"
              />
              <Button size="sm" onClick={postComment} disabled={busy || !commentBody.trim()}>
                Post
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: ExceptionStatus }) {
  const map: Record<ExceptionStatus, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
    submitted:      { variant: "secondary",   label: "Submitted" },
    acknowledged:   { variant: "secondary",   label: "Acknowledged" },
    under_review:   { variant: "secondary",   label: "Under review" },
    resolved:       { variant: "outline",     label: "Resolved" },
    escalated:      { variant: "destructive", label: "Escalated" },
    withdrawn:      { variant: "outline",     label: "Withdrawn" },
  };
  const s = map[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function relativeTime(target: Date): string {
  const diffMs = target.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const hr = 3_600_000;
  const day = 24 * hr;
  const past = diffMs < 0;
  let text: string;
  if (abs < hr) text = `${Math.round(abs / 60_000)}m`;
  else if (abs < day) text = `${Math.round(abs / hr)}h`;
  else text = `${Math.round(abs / day)}d`;
  return past ? `by ${text} ago` : `in ${text}`;
}
