import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Check, ShieldCheck, UserCheck } from "lucide-react";
import {
  computeTraineeProgress,
  type SignoffStatus,
  type SpecialtyProgress,
} from "@/features/competencies/progress";
import type {
  Competency,
  CompetencyRequirement,
  StaffCompetency,
} from "@/features/competencies/competencies";

export const Route = createFileRoute("/_authenticated/me/competencies")({
  head: () => ({
    meta: [
      { title: "My competency progress — Salisbury Anaesthetics Rota" },
      {
        name: "description",
        content:
          "Personal view of required competency sign-offs and eligible supervisors per specialty.",
      },
    ],
  }),
  component: MyCompetenciesPage,
});

const TODAY = new Date().toISOString().slice(0, 10);

function MyCompetenciesPage() {
  const { user } = useAuth();
  return (
    <div className="space-y-4">
      <PageHeader
        title="My competency progress"
        description="Required sign-offs across each specialty, plus the consultants eligible to supervise or run each list."
      />
      <Tabs defaultValue="progress">
        <TabsList>
          <TabsTrigger value="progress">My progress</TabsTrigger>
          <TabsTrigger value="eligibility">Who can run each list</TabsTrigger>
        </TabsList>
        <TabsContent value="progress" className="mt-4">
          {user ? <ProgressTab staffId={user.id} /> : null}
        </TabsContent>
        <TabsContent value="eligibility" className="mt-4">
          <EligibilityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ------------------------------------------------------------------
// Progress
// ------------------------------------------------------------------

function ProgressTab({ staffId }: { staffId: string }) {
  const { data: comps } = useQuery({
    queryKey: ["competencies-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("competencies")
        .select("id,code,name,description,category,applies_to_grades,active,sort_order")
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as Competency[];
    },
  });
  const { data: specialties } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const { data: reqs } = useQuery({
    queryKey: ["specialty-competency-requirements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialty_competency_requirements")
        .select("id,specialty_id,competency_id,requirement,applies_to_role");
      if (error) throw error;
      return (data ?? []) as CompetencyRequirement[];
    },
  });
  const { data: myHoldings } = useQuery({
    queryKey: ["my-staff-competencies", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_competencies")
        .select("id,staff_id,competency_id,level,granted_at,expires_at,revoked_at,notes")
        .eq("staff_id", staffId);
      if (error) throw error;
      return (data ?? []) as StaffCompetency[];
    },
  });

  const progress = useMemo<SpecialtyProgress[]>(() => {
    if (!comps || !specialties || !reqs || !myHoldings) return [];
    return computeTraineeProgress({
      staffId,
      onDate: TODAY,
      specialties,
      competencies: comps,
      requirements: reqs,
      staffCompetencies: myHoldings,
    });
  }, [comps, specialties, reqs, myHoldings, staffId]);

  const totals = useMemo(() => {
    let total = 0, held = 0;
    for (const s of progress) { total += s.requiredTotal; held += s.requiredHeld; }
    return { total, held };
  }, [progress]);

  if (!comps || !specialties || !reqs || !myHoldings) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (progress.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No specialty competency requirements have been configured yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Overall required sign-offs
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">
              {totals.held} / {totals.total} required competencies signed off
            </span>
            <span className="text-xs text-muted-foreground">
              {totals.total > 0 ? Math.round((totals.held / totals.total) * 100) : 0}%
            </span>
          </div>
          <Progress value={totals.total > 0 ? (totals.held / totals.total) * 100 : 0} />
        </CardContent>
      </Card>

      {progress.map((spec) => (
        <SpecialtyProgressCard key={spec.specialtyId} spec={spec} />
      ))}
    </div>
  );
}

function SpecialtyProgressCard({ spec }: { spec: SpecialtyProgress }) {
  const pct = spec.requiredTotal > 0
    ? Math.round((spec.requiredHeld / spec.requiredTotal) * 100)
    : 100;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-4">
          <span>{spec.specialtyName}</span>
          <span className="text-sm font-normal text-muted-foreground">
            {spec.requiredHeld} / {spec.requiredTotal} required · {pct}%
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Progress value={pct} className="mb-3" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Competency</TableHead>
              <TableHead>Requirement</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spec.items.map((it) => (
              <TableRow key={it.competencyId}>
                <TableCell>
                  <div>{it.competencyName}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {it.competencyCode}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={it.requirement === "required" ? "default" : "outline"}>
                    {it.requirement}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs capitalize">{it.appliesToRole}</TableCell>
                <TableCell>
                  <StatusBadge
                    status={it.status}
                    level={it.level}
                    daysUntilExpiry={it.daysUntilExpiry}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  status, level, daysUntilExpiry,
}: {
  status: SignoffStatus;
  level: "independent" | "supervised" | "aware" | null;
  daysUntilExpiry: number | null;
}) {
  switch (status) {
    case "signed_off_independent":
      return (
        <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1">
          <Check className="h-3 w-3" /> Independent
        </Badge>
      );
    case "signed_off_supervised":
      return (
        <Badge variant="secondary" className="gap-1">
          <UserCheck className="h-3 w-3" /> Supervised
        </Badge>
      );
    case "signed_off_unspecified":
      return (
        <Badge variant="secondary" className="gap-1">
          <Check className="h-3 w-3" /> Signed off{level ? ` (${level})` : ""}
        </Badge>
      );
    case "expiring":
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-700 gap-1">
          <AlertTriangle className="h-3 w-3" /> Expires in {daysUntilExpiry}d
        </Badge>
      );
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "revoked":
      return <Badge variant="destructive">Revoked</Badge>;
    case "missing":
    default:
      return <Badge variant="outline" className="text-muted-foreground">Not yet signed off</Badge>;
  }
}

// ------------------------------------------------------------------
// Eligibility per list
// ------------------------------------------------------------------

interface EligibilityRow {
  specialty_id: string;
  specialty_name: string;
  staff_id: string;
  full_name: string;
  grade: string | null;
  eligible_solo: boolean;
  eligible_supervising: boolean;
}

function EligibilityTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["competency-eligibility", TODAY],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_competency_eligibility", {
        p_on_date: TODAY,
      });
      if (error) throw error;
      return (data ?? []) as EligibilityRow[];
    },
  });

  const grouped = useMemo(() => {
    const map = new Map<string, {
      name: string;
      solo: EligibilityRow[];
      supervising: EligibilityRow[];
    }>();
    for (const row of data ?? []) {
      if (!row.eligible_solo && !row.eligible_supervising) continue;
      let entry = map.get(row.specialty_id);
      if (!entry) {
        entry = { name: row.specialty_name, solo: [], supervising: [] };
        map.set(row.specialty_id, entry);
      }
      if (row.eligible_solo) entry.solo.push(row);
      if (row.eligible_supervising && !row.eligible_solo) {
        entry.supervising.push(row);
      }
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Could not load eligibility: {(error as Error).message}
        </CardContent>
      </Card>
    );
  }
  if (grouped.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No specialty has eligible staff yet — either no requirements are
          configured or no sign-offs have been recorded.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {grouped.map((spec) => (
        <Card key={spec.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{spec.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Solo eligible ({spec.solo.length})
              </div>
              {spec.solo.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nobody currently eligible.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {spec.solo.map((s) => (
                    <Badge key={s.staff_id} variant="secondary" className="gap-1">
                      {s.full_name}
                      {s.grade && s.grade !== "consultant" && (
                        <span className="text-[10px] opacity-70">({s.grade})</span>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            {spec.supervising.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                  Supervising only ({spec.supervising.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {spec.supervising.map((s) => (
                    <Badge key={s.staff_id} variant="outline" className="gap-1">
                      {s.full_name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
