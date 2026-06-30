import { createFileRoute } from "@tanstack/react-router";
import {
  convertToModelMessages,
  generateText,
  Output,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { GLOSSARY } from "@/lib/glossary";

const CANONICAL_GLOSSARY = GLOSSARY.map((g) => {
  const head = g.acronym ? `${g.acronym} — ${g.term}` : g.term;
  const related = g.related && g.related.length ? ` (see also: ${g.related.join(", ")})` : "";
  return `- ${head}: ${g.definition}${related}`;
}).join("\n");

const SYSTEM_PROMPT = `You are an expert data analyst for the Salisbury District General Hospital
(SDH) Anaesthetics Department rota application. The current user is an ADMIN. Your job is to take
a plain-English audit or data-analysis request and turn it into a clear report.

CANONICAL GLOSSARY (this is the SAME glossary shown to users in-app at /glossary and in
hover tooltips throughout the UI — when a user asks "what does X mean?" or uses one of these
acronyms, your explanation MUST be consistent with these definitions; quote them verbatim
where possible and do not invent alternative meanings):
${CANONICAL_GLOSSARY}


DEPARTMENT CONTEXT (Salisbury)
- Salisbury District Hospital (SDH) main theatre complex: 10 main NHS theatres, numbered
  Theatre 1–Theatre 10 (theatres.kind = 'main', sort_order 1–10).
- Day Surgery Unit (DSU) at SDH: 3 day-surgery theatres — Day Surgery A, B and F
  (theatres.kind = 'day_surgery').
- Other SDH 'main' lists that aren't numbered theatres but run from the main complex:
  Pain, POAU (Pre-Operative Assessment Unit), Endo (Endoscopy), MRI, Cardioversions, Laser.
- New Hall Hospital (NHH) — the local PRIVATE hospital where the department also provides
  anaesthetic cover: 5 theatres, NHH Theatre 1–5 (theatres.kind = 'private'). Do NOT confuse
  the private hospital "NHH" with the on-call duty_type 'nhh_oncall' (see GLOSSARY).
- A legacy row 'NHH (legacy)' exists with active = false; exclude inactive theatres unless asked.

STAFF GROUPS (profiles.grade + profiles.training_level)
- 'consultant' — substantive consultant anaesthetists. Have a job_plan (PAs split into DCC/SPA),
  may be LTFT. Lead lists, supervise trainees, do SPA/admin time, and cover on-call rotas.
- 'sas' — Specialty and Associate Specialist doctors (training_level values include
  'SAS', 'Speciality Doctor', 'Associate Specialist'). Senior career-grade non-consultants;
  generally work independently like consultants but do not have SPA in the consultant sense.
- 'trainee' — anaesthetic trainees rotating through the department. training_level encodes
  seniority: 'ACCS', 'CT1', 'CT2', 'FY2' (junior / "SHO-level"); 'ST1'–'ST7' (registrar-level,
  ST3+ = senior registrar); 'Fellow' (post-CCT or specialist fellow); 'Locum' / 'Extra' = ad-hoc
  cover. Trainees have a rotation_end_date — never roster a trainee after that date.
- Use \`profiles.active = true\` unless the user explicitly wants leavers/inactive staff.

ROTA DUTIES (rota_assignments.duty_type)
- 'theatre'              — clinical theatre list (main, day surgery, or NHH private).
- 'spa'                  — Supporting Professional Activity (non-clinical consultant time:
                           appraisal, audit, teaching prep, management, CPD). Counts toward
                           job-plan SPA PAs, not DCC.
- 'admin'                — Administrative / management session (similar to SPA but specifically
                           administrative). Non-clinical.
- 'teaching'             — Departmental or trainee teaching session.
- 'obstetrics'           — Labour-ward / obstetric anaesthesia cover (1st on).
- 'obstetrics_2nd'       — Second obstetric anaesthetist (back-up to obstetrics).
- 'nhh_oncall'           — Non-resident "Hospital at Night / Night Hospital" style on-call
                           covering the wider hospital out of hours. (NOT the private NHH hospital
                           — naming collision; nhh_oncall is the on-call duty.)
- 'consultant_in_charge' — Consultant of the day coordinating the theatre complex.
- 'general_consultant_oncall' — Consultant on-call for general theatres/emergencies.
- 'icu_consultant_oncall'    — Consultant on-call for ICU.
- 'icu_ct2_plus'         — ICU trainee at CT2 level or above.
- 'icu_trainee'          — ICU trainee (general).
- 'registrar_oncall'     — Anaesthetic registrar on-call (ST3+ usually).
- 'sho_oncall'           — Junior anaesthetic on-call (CT1/CT2/FY2/ACCS-level).

GLOSSARY (rota terminology you WILL see)
- SPA   = Supporting Professional Activity — non-clinical consultant time. In a consultant
          job plan, total PAs = DCC PAs + SPA PAs (see \`job_plans\`).
- DCC   = Direct Clinical Care PAs (the clinical portion of a job plan).
- PA    = Programmed Activity — 4-hour unit of consultant work.
- LTFT  = Less Than Full Time (profiles.ltft / job_plans.ltft + ltft_percentage).
- NHH   = Two distinct meanings — disambiguate by context:
            1. New Hall Hospital — the local private hospital with 5 theatres.
            2. \`nhh_oncall\` duty_type — non-resident on-call for the main hospital
               ("Night Hospital" cover). When the user just says "NHH" ask which they mean
               if it is not obvious from context.
- DSU   = Day Surgery Unit (the 3 day-surgery theatres at SDH).
- POAU  = Pre-Operative Assessment Unit.
- Consultant of the Day / "CoD" — maps to duty_type 'consultant_in_charge'.
- "On-call" / "on-cover" — any of the *_oncall duty_types above, depending on grade.
- "Solo list" (for trainees) — a theatre list where the trainee is the anaesthetist of record
  without direct consultant supervision; check role_on_list / supervisor_id on rota_assignments.

WORKFLOW
1. Restate the request in one sentence so we are aligned.
2. Ask any clarifying questions you genuinely need (date ranges, which staff groups/grades to
   include, whether to include LTFT pro-rata, how to handle leave/sickness, whether to include
   private NHH lists, definitions of "shift" / "hours" / "session", etc.). 1–3 focused questions
   at a time. Do not re-ask things already answered earlier in the conversation or already
   recorded in LONG-TERM MEMORY below.
3. Once you have enough information, use the \`describe_schema\` tool to inspect the relevant
   tables (NEVER guess column names). Then call \`run_sql\` with a single read-only SELECT/WITH
   query and a short human-readable \`title\`. You may call \`run_sql\` multiple times if the
   report needs several views. If a chart would help, include a \`chart\` spec.
4. After running queries, write a concise narrative summary in markdown explaining what the
   data shows, any caveats (e.g. data only goes back X weeks, NHH not included, etc.), and
   notable patterns. Reference the queries by their titles.

LONG-TERM MEMORY (CRITICAL — read this carefully)
You have a persistent memory store that is SHARED across all admin users and all
conversations. It survives reloads and new sessions. Use it to get better over time.

Current stored memories are listed below under "STORED MEMORIES". Treat them as binding
defaults / corrections from previous sessions — apply them automatically without re-asking.

Use the \`save_memory\` tool to record something whenever ANY of these happen:
  - The user corrects you (wrong column, wrong join, wrong definition, wrong assumption).
  - The user states a preference for how reports should be structured (e.g. "always exclude
    leavers", "always show consultants and SAS together", "for SPA totals use scheduled hours
    not session count", "private NHH should be reported separately by default").
  - You discover a non-obvious fact about the schema (e.g. "rota_assignments with
    duty_type='spa' and theatre_session_id=null are the canonical SPA sessions",
    "trainee solo lists are flagged by role_on_list='solo'").
  - You make a mistake and want future-you to avoid it (kind='lesson' or 'correction').

Use \`forget_memory\` to remove an entry when the user says it was wrong or out of date.
Use \`list_memories\` if you need to re-read the full memory store mid-conversation.

Memory hygiene: keep each entry to one focused sentence or two. Prefer specific, actionable
rules ("Always filter profiles.active=true unless asked") over vague observations. Add a
short \`tags\` array (e.g. ["spa","reports"]) so memories stay searchable. Do NOT save
personal data about staff, transient session state, or things the user explicitly said were
one-offs.

QUERY RULES
- Single statement, SELECT or WITH only. No semicolons inside. No DDL/DML.
- Schema is \`public\`. Use \`information_schema\` via the \`describe_schema\` tool, not in \`run_sql\`.
- Always alias aggregate columns (e.g. \`COUNT(*) AS sessions\`).
- Order results sensibly. Limit to the top N rows when there could be many — the system
  hard-caps at 5000 rows regardless.
- For per-week / per-month aggregations, use \`date_trunc('week', session_date)\` etc.
- Dates are stored as \`date\`. \`session\` is an enum: am, pm, eve, night, long_day.
- Sessions 'am' and 'pm' are nominally ~4h each (one PA). 'eve' ~3h. 'long_day' ~10h.
  'night' ~13h. These are conventions for this department.
- To filter by site/theatre type, join \`theatre_sessions\` -> \`theatres\` and use
  \`theatres.kind\` ('main' | 'day_surgery' | 'private') and/or \`theatres.active\`.
- Exclude theatres.active = false unless the user asks for legacy data.

KEY TABLES (quick reference — confirm columns with describe_schema before querying)
- profiles: id, full_name, email, grade ('consultant'|'sas'|'trainee'), training_level,
  active, ltft, rotation_end_date, left_at
- rota_assignments: id, staff_id, session_date, session, role_on_list, duty_type,
  theatre_session_id, supervisor_id, source, notes
- theatre_sessions, theatres (kind, sort_order, active), specialties
- leave_requests: id, staff_id, leave_type, start_date, end_date, status, decided_at, notes
- leave_allowances: id, staff_id, leave_year_start, leave_type, allowance_days, carried_over_days
- job_plans: id, staff_id, total_pas, dcc_pas, spa_pas, ltft, ltft_percentage, valid_from, valid_to
- user_roles: user_id, role (do NOT query the auth schema)

CHART SPEC SHAPE
{ "type": "bar" | "line" | "pie", "xKey": "<column>", "yKeys": ["<column>"], "title": "..." }
Only include a chart when the result set has an obvious x/y story (≤30 rows, numeric y).

PROFESSIONAL REPORTS (\`generate_report\` tool)
When the user asks for a "report", "audit report", "summary", "writeup", "briefing" or
similar, OR after you have run enough queries to draw conclusions, call \`generate_report\`
to produce a structured, professional-looking audit report. The UI renders it inline as a
formatted document and exposes a one-click PDF export, so this is the preferred final
deliverable for any non-trivial analysis.

Requirements for a good report:
- title: short, specific (e.g. "Consultant Weekly Clinical Hours — Q1 2026").
- executive_summary: 2–4 sentences in plain prose giving the headline answer.
- key_findings: 3–7 succinct bullets, each one self-contained and quantified where possible.
- sections: 2–5 sections, each with a heading and either prose, bullets, or a chart
  (or any combination). Use charts to make patterns visible — bar for comparisons,
  line for trends over time, pie/doughnut for shares of a whole (max ~6 slices).
- recommendations (optional): concrete next steps the admin can take.
- caveats (optional): data limitations, exclusions, assumptions.
- Tone: professional, concise, evidence-led. No filler. Reference data from prior
  \`run_sql\` queries by their titles where relevant.
- Charts: keep labels short, data ≤ 20 points per dataset, ≤ 4 datasets per chart.

Be friendly, concise, and use markdown. Use the user's terminology where reasonable.`;


function getAdminClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getUserClient(token: string) {
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function getAuthenticatedUserId(authHeader: string | null) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, token };
}

async function isAdmin(userId: string) {
  const admin = getAdminClient();
  const { data } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return !!data;
}

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a QuickChart.io URL for a chart spec produced by the
 * `generate_report` tool. QuickChart renders Chart.js configs as PNG/SVG
 * server-side so the same image embeds cleanly in both the inline UI and
 * the downloadable PDF.
 */
function buildQuickChartUrl(chart: {
  type: "bar" | "line" | "pie" | "doughnut";
  title?: string;
  labels: string[];
  datasets: Array<{ label: string; data: number[] }>;
}): string {
  // Professional, accessible palette (chosen for print + screen contrast).
  const palette = [
    "#2563eb", "#16a34a", "#dc2626", "#d97706",
    "#7c3aed", "#0891b2", "#db2777", "#65a30d",
  ];

  const isCategorical = chart.type === "pie" || chart.type === "doughnut";
  const datasets = chart.datasets.map((ds, i) => {
    if (isCategorical) {
      return {
        label: ds.label,
        data: ds.data,
        backgroundColor: chart.labels.map((_, j) => palette[j % palette.length]),
        borderColor: "#ffffff",
        borderWidth: 2,
      };
    }
    const color = palette[i % palette.length];
    return {
      label: ds.label,
      data: ds.data,
      backgroundColor: chart.type === "line" ? color + "33" : color,
      borderColor: color,
      borderWidth: 2,
      fill: chart.type === "line",
      tension: chart.type === "line" ? 0.3 : 0,
      pointRadius: chart.type === "line" ? 3 : 0,
    };
  });

  const config = {
    type: chart.type,
    data: { labels: chart.labels, datasets },
    options: {
      plugins: {
        title: chart.title
          ? { display: true, text: chart.title, font: { size: 16, weight: "bold" } }
          : { display: false },
        legend: {
          display: isCategorical || chart.datasets.length > 1,
          position: isCategorical ? "right" : "top",
          labels: { font: { size: 12 } },
        },
      },
      scales: isCategorical
        ? undefined
        : {
            y: { beginAtZero: true, grid: { color: "#e5e7eb" } },
            x: { grid: { display: false } },
          },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?w=720&h=380&bkg=white&format=png&c=${encoded}`;
}


/**
 * Build a compact, current-data snapshot of the rota dataset to inject into
 * the audit assistant's system prompt every turn. Complements the static
 * department description (theatres, staff groups, duty types) with the
 * actual values present in the database right now, so the model never has
 * to guess a theatre name, a training level, or whether a duty_type is
 * still in use.
 *
 * Kept compact: counts and small samples only. Detailed lookups still go
 * via the focused tools (`list_theatres`, `list_staff_groups`,
 * `list_duty_categories`, `find_staff`) or `run_sql` for ad-hoc needs.
 */
async function buildDepartmentSnapshot(admin: SupabaseClient): Promise<string> {
  const [theatresRes, profilesRes, dutyRes, specialtiesRes] = await Promise.all([
    admin
      .from("theatres")
      .select("name, kind, active, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .limit(200),
    admin
      .from("profiles_v")
      .select("grade, training_level, active")
      .eq("active", true)
      .limit(2000),
    admin
      .from("rota_assignments")
      .select("duty_type")
      .gte("session_date", isoDaysAgo(30))
      .not("duty_type", "is", null)
      .limit(20000),
    admin
      .from("specialties")
      .select("name")
      .order("name", { ascending: true })
      .limit(100),
  ]);

  const lines: string[] = [];

  if (!theatresRes.error && theatresRes.data?.length) {
    const byKind = new Map<string, string[]>();
    for (const t of theatresRes.data) {
      const key = (t.kind ?? "other") as string;
      const list = byKind.get(key) ?? [];
      list.push(t.name);
      byKind.set(key, list);
    }
    const kindOrder = ["main", "day_surgery", "private", "other"];
    const parts: string[] = [];
    for (const k of kindOrder) {
      const list = byKind.get(k);
      if (!list?.length) continue;
      parts.push(`${k} (${list.length}): ${list.join(", ")}`);
    }
    lines.push(`ACTIVE THEATRES — ${parts.join(" | ")}`);
  }

  if (!profilesRes.error && profilesRes.data?.length) {
    const byGrade = new Map<string, Map<string, number>>();
    for (const p of profilesRes.data) {
      const g = (p.grade ?? "unknown") as string;
      const lvl = (p.training_level ?? "—") as string;
      const inner = byGrade.get(g) ?? new Map<string, number>();
      inner.set(lvl, (inner.get(lvl) ?? 0) + 1);
      byGrade.set(g, inner);
    }
    const gradeLines: string[] = [];
    for (const [g, inner] of byGrade.entries()) {
      const total = Array.from(inner.values()).reduce((a, b) => a + b, 0);
      const breakdown = Array.from(inner.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([lvl, n]) => `${lvl}=${n}`)
        .join(", ");
      gradeLines.push(`${g} (${total}): ${breakdown}`);
    }
    lines.push(`ACTIVE STAFF — ${gradeLines.join(" | ")}`);
  }

  if (!dutyRes.error && dutyRes.data?.length) {
    const counts = new Map<string, number>();
    for (const r of dutyRes.data) {
      const k = r.duty_type as string;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    lines.push(
      `DUTY TYPES IN USE (last 30d) — ${ranked
        .map(([k, n]) => `${k}=${n}`)
        .join(", ")}`,
    );
  }

  if (!specialtiesRes.error && specialtiesRes.data?.length) {
    lines.push(
      `SPECIALTIES (${specialtiesRes.data.length}) — ${specialtiesRes.data
        .map((s) => s.name)
        .join(", ")}`,
    );
  }

  if (lines.length === 0) return "";
  return `\n\nLIVE DEPARTMENT SNAPSHOT (refreshed on every turn — use these exact names/values; if something here contradicts the static description above, trust the snapshot):\n${lines
    .map((l) => `- ${l}`)
    .join("\n")}`;
}

/**
 * After each completed turn, ask a small model to inspect the last
 * user message + assistant reply and decide whether anything durable
 * (a correction, preference, lesson, or non-obvious fact) should be
 * persisted to `audit_assistant_memories`. Cheap, best-effort, runs
 * in the background of `onFinish` — failures are swallowed.
 */
async function autoExtractMemory(opts: {
  admin: SupabaseClient;
  apiKey: string;
  userMessage: string;
  assistantText: string;
  existingMemoryContents: string[];
  createdBy: string;
}): Promise<void> {
  const { admin, apiKey, userMessage, assistantText, existingMemoryContents, createdBy } = opts;
  if (!userMessage.trim() || !assistantText.trim()) return;

  const gateway = createLovableAiGatewayProvider(apiKey);
  const recent = existingMemoryContents.slice(0, 60).join("\n- ");

  let parsed: {
    save: boolean;
    kind?: "lesson" | "preference" | "fact" | "correction";
    content?: string;
    tags?: string[];
    reason?: string;
  };
  try {
    const result = await generateText({
      model: gateway("google/gemini-2.5-flash-lite"),
      system:
        "You decide whether a single, durable memory should be saved for an admin audit assistant. " +
        "Save ONLY when the exchange clearly contains: (1) a correction the user made to the assistant, " +
        "(2) a stated preference for how reports should be done, (3) a non-obvious schema/domain fact " +
        "the assistant discovered, or (4) a lesson the assistant should not repeat. " +
        "Do NOT save: routine Q&A, transient one-offs, personal data about staff, anything already " +
        "covered by an existing memory. Keep `content` to one focused sentence. If nothing qualifies, " +
        "set save=false.",
      prompt:
        `EXISTING MEMORIES (do not duplicate):\n- ${recent || "(none)"}\n\n` +
        `USER MESSAGE:\n${userMessage.slice(0, 4000)}\n\n` +
        `ASSISTANT REPLY:\n${assistantText.slice(0, 6000)}`,
      experimental_output: Output.object({
        schema: z.object({
          save: z.boolean(),
          kind: z.enum(["lesson", "preference", "fact", "correction"]).optional(),
          content: z.string().max(500).optional(),
          tags: z.array(z.string().max(30)).max(6).optional(),
          reason: z.string().max(200).optional(),
        }),
      }),
    });
    parsed = result.experimental_output;
  } catch (e) {
    console.warn("autoExtractMemory: model call failed", e);
    return;
  }

  if (!parsed.save || !parsed.kind || !parsed.content) return;

  // Belt-and-braces dedupe: skip if an existing memory has the same content.
  const normalized = parsed.content.trim().toLowerCase();
  if (existingMemoryContents.some((c) => c.trim().toLowerCase() === normalized)) return;

  const { error } = await admin.from("audit_assistant_memories").insert({
    kind: parsed.kind,
    content: parsed.content.trim(),
    tags: parsed.tags ?? ["auto"],
    created_by: createdBy,
  });
  if (error) console.warn("autoExtractMemory: insert failed", error.message);
}

export const Route = createFileRoute("/api/audit-tool")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await getAuthenticatedUserId(request.headers.get("authorization"));
        if (!auth) return new Response("Unauthorized", { status: 401 });
        if (!(await isAdmin(auth.userId))) {
          return new Response("Forbidden — admin role required", { status: 403 });
        }

        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const AuditMessage = z.object({
          id: z.string().optional(),
          role: z.enum(["system", "user", "assistant"]),
          parts: z.array(z.record(z.any())).optional(),
          content: z.string().optional(),
        }).passthrough();
        const AuditBody = z.object({
          messages: z.array(AuditMessage)
            .min(1, "Please send at least one message to start the audit.")
            .max(500, "Conversation is too long — please start a new audit."),
        });

        let parsed: z.infer<typeof AuditBody>;
        try {
          const raw = await request.json();
          parsed = AuditBody.parse(raw);
        } catch (e) {
          const friendly = e instanceof z.ZodError
            ? e.errors.slice(0, 3).map((x) => {
                const field = x.path.join(".") || "request";
                return `“${field}”: ${x.message}`;
              }).join("; ")
            : "The request body wasn't valid JSON.";
          return new Response(`We couldn't start the audit. ${friendly}`, { status: 400 });
        }
        const messages = parsed.messages as unknown as UIMessage[];


        const userClient = getUserClient(auth.token);
        const adminClient = getAdminClient();

        // Load long-term memories (shared across all admins) and inject into system prompt.
        const { data: memoryRows } = await adminClient
          .from("audit_assistant_memories")
          .select("id, kind, content, tags, created_at")
          .order("created_at", { ascending: false })
          .limit(200);

        const memoryBlock =
          memoryRows && memoryRows.length > 0
            ? memoryRows
                .map(
                  (m) =>
                    `- [${m.kind}] (id=${m.id}${
                      m.tags && m.tags.length ? `, tags=${m.tags.join(",")}` : ""
                    }) ${m.content}`,
                )
                .join("\n")
            : "(no memories yet — save useful lessons as you learn them)";

        // Live snapshot of theatres, staff groups, duty types, specialties.
        // Best-effort: if it fails we still answer using the static prompt.
        let snapshotBlock = "";
        try {
          snapshotBlock = await buildDepartmentSnapshot(adminClient);
        } catch (e) {
          console.warn("buildDepartmentSnapshot failed", e);
        }

        const fullSystem = `${SYSTEM_PROMPT}\n\nSTORED MEMORIES (newest first):\n${memoryBlock}${snapshotBlock}`;

        const tools = {
          describe_schema: tool({
            description:
              "Inspect the public schema. Pass `tables: []` to list all public tables. " +
              "Pass `tables: ['rota_assignments','profiles']` to get column name + data_type " +
              "for those tables. Use BEFORE writing any SQL so you reference real columns.",
            inputSchema: z.object({
              tables: z.array(z.string()).max(20).optional(),
            }),
            execute: async ({ tables }) => {
              if (!tables || tables.length === 0) {
                const { data, error } = await userClient.rpc("admin_run_readonly_sql", {
                  p_query:
                    "SELECT table_name FROM information_schema.tables " +
                    "WHERE table_schema = 'public' ORDER BY table_name",
                });
                if (error) return { error: error.message };
                return { tables: (data as Array<{ table_name: string }>).map((r) => r.table_name) };
              }

              // Use the readonly SQL to fetch columns
              const sql = `SELECT table_name, column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name IN (${tables.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})
                ORDER BY table_name, ordinal_position`;
              const { data, error } = await userClient.rpc("admin_run_readonly_sql", {
                p_query: sql,
              });
              if (error) return { error: error.message };
              return { columns: data };
            },
          }),

          run_sql: tool({
            description:
              "Run a single read-only SELECT/WITH query against the public schema and return " +
              "the rows. Provide a short human-readable `title` for the report panel. Optionally " +
              "include a `chart` spec so the UI renders a chart alongside the table. Rows are " +
              "capped at 5000. Query timeout is 15 seconds.",
            inputSchema: z.object({
              title: z.string().min(2).max(120),
              sql: z.string().min(10).max(8000),
              chart: z
                .object({
                  type: z.enum(["bar", "line", "pie"]),
                  xKey: z.string(),
                  yKeys: z.array(z.string()).min(1).max(5),
                  title: z.string().optional(),
                })
                .optional(),
            }),
            execute: async ({ title, sql, chart }) => {
              const { data, error } = await userClient.rpc("admin_run_readonly_sql", {
                p_query: sql,
              });
              if (error) return { error: error.message, title, sql };
              const rows = (data as Record<string, unknown>[] | null) ?? [];
              const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
              return {
                title,
                sql,
                chart: chart ?? null,
                rowCount: rows.length,
                columns,
                // Cap inline preview to keep the LLM context small; UI gets full rows
                rowsPreview: rows.slice(0, 20),
                rows,
              };
            },
          }),

          save_memory: tool({
            description:
              "Save a long-term memory shared across all admin conversations. Use whenever the " +
              "user corrects you, states a lasting preference, or you learn a non-obvious " +
              "schema/domain fact you want future-you to remember. Keep `content` to one or two " +
              "focused sentences. `kind`: 'lesson' (mistake to avoid), 'correction' (user " +
              "corrected a fact), 'preference' (how the user wants reports), 'fact' (durable " +
              "schema/domain fact).",
            inputSchema: z.object({
              kind: z.enum(["lesson", "preference", "fact", "correction"]),
              content: z.string().min(5).max(1000),
              tags: z.array(z.string().max(40)).max(8).optional(),
            }),
            execute: async ({ kind, content, tags }) => {
              const { data, error } = await adminClient
                .from("audit_assistant_memories")
                .insert({
                  kind,
                  content,
                  tags: tags ?? [],
                  created_by: auth.userId,
                })
                .select("id")
                .single();
              if (error) return { error: error.message };
              return { saved: true, id: data.id };
            },
          }),

          forget_memory: tool({
            description:
              "Delete a stored memory by id. Use when the user says a stored memory is wrong " +
              "or out of date. The id is shown in the STORED MEMORIES block of the system prompt.",
            inputSchema: z.object({ id: z.string().uuid() }),
            execute: async ({ id }) => {
              const { error } = await adminClient
                .from("audit_assistant_memories")
                .delete()
                .eq("id", id);
              if (error) return { error: error.message };
              return { deleted: true, id };
            },
          }),

          list_memories: tool({
            description:
              "Return the full current memory store. Usually unnecessary because memories are " +
              "already injected into the system prompt, but useful if you need a fresh read " +
              "after saving/deleting.",
            inputSchema: z.object({}).optional(),
            execute: async () => {
              const { data, error } = await adminClient
                .from("audit_assistant_memories")
                .select("id, kind, content, tags, created_at")
                .order("created_at", { ascending: false })
                .limit(200);
              if (error) return { error: error.message };
              return { memories: data ?? [] };
            },
          }),

          // ---- Focused reference tools ------------------------------------
          // Complement the live snapshot with on-demand drilldowns so the
          // model doesn't need to fall back to `run_sql` for routine
          // questions about theatres, staffing or duty mix.

          list_theatres: tool({
            description:
              "Return the department's theatres (one row per theatre). Use to look up exact names, " +
              "split by kind (main / day_surgery / private), and check active status. Defaults to active only.",
            inputSchema: z.object({
              kind: z.enum(["main", "day_surgery", "private"]).optional(),
              include_inactive: z.boolean().optional(),
            }),
            execute: async ({ kind, include_inactive }) => {
              let q = adminClient
                .from("theatres")
                .select("id, name, kind, active, sort_order")
                .order("sort_order", { ascending: true });
              if (!include_inactive) q = q.eq("active", true);
              if (kind) q = q.eq("kind", kind);
              const { data, error } = await q.limit(200);
              if (error) return { error: error.message };
              return { theatres: data ?? [] };
            },
          }),

          list_staff_groups: tool({
            description:
              "Return active staff counts broken down by grade and training_level, so you can see " +
              "how the department is composed (e.g. how many ST5 trainees, how many SAS doctors). " +
              "Use this before answering any question about staffing mix.",
            inputSchema: z.object({
              grade: z.enum(["consultant", "sas", "trainee"]).optional(),
            }),
            execute: async ({ grade }) => {
              let q = adminClient
                .from("profiles_v")
                .select("grade, training_level")
                .eq("active", true)
                .limit(2000);
              if (grade) q = q.eq("grade", grade);
              const { data, error } = await q;
              if (error) return { error: error.message };
              const counts = new Map<string, Map<string, number>>();
              for (const p of data ?? []) {
                const g = (p.grade ?? "unknown") as string;
                const lvl = (p.training_level ?? "—") as string;
                const inner = counts.get(g) ?? new Map<string, number>();
                inner.set(lvl, (inner.get(lvl) ?? 0) + 1);
                counts.set(g, inner);
              }
              const groups = Array.from(counts.entries()).map(([g, inner]) => ({
                grade: g,
                total: Array.from(inner.values()).reduce((a, b) => a + b, 0),
                training_levels: Array.from(inner.entries())
                  .map(([level, count]) => ({ level, count }))
                  .sort((a, b) => b.count - a.count),
              }));
              return { groups };
            },
          }),

          list_duty_categories: tool({
            description:
              "Return a histogram of rota_assignments.duty_type values used in a date window " +
              "(default: last 30 days). Use this to confirm which duty_types are actually in use " +
              "and how heavily each is staffed before writing reports about duty mix.",
            inputSchema: z.object({
              days_back: z.number().int().min(1).max(365).optional(),
            }),
            execute: async ({ days_back }) => {
              const from = isoDaysAgo(days_back ?? 30);
              const { data, error } = await adminClient
                .from("rota_assignments")
                .select("duty_type")
                .gte("session_date", from)
                .not("duty_type", "is", null)
                .limit(50000);
              if (error) return { error: error.message };
              const counts = new Map<string, number>();
              for (const r of data ?? []) {
                const k = r.duty_type as string;
                counts.set(k, (counts.get(k) ?? 0) + 1);
              }
              return {
                window: { from, days: days_back ?? 30 },
                duty_types: Array.from(counts.entries())
                  .map(([duty_type, count]) => ({ duty_type, count }))
                  .sort((a, b) => b.count - a.count),
              };
            },
          }),

          find_staff: tool({
            description:
              "Find staff by case-insensitive partial name or email match. Returns id, name, " +
              "grade, training level and active flag — use to resolve a name before SQL filters " +
              "on staff_id.",
            inputSchema: z.object({
              query: z.string().min(1).max(120),
              limit: z.number().int().min(1).max(20).optional(),
            }),
            execute: async ({ query, limit }) => {
              const q = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
              const { data, error } = await adminClient
                .from("profiles_v")
                .select("id, full_name, email, grade, training_level, active")
                .or(`full_name.ilike.${q},email.ilike.${q}`)
                .limit(limit ?? 10);
              if (error) return { error: error.message };
              return { staff: data ?? [] };
            },
          }),

          generate_report: tool({
            description:
              "Produce a structured, professional audit report from the analysis you have done. " +
              "The UI renders this inline as a formatted document with chart graphics and offers " +
              "one-click PDF export. Call this once you have enough evidence (typically after one " +
              "or more run_sql calls) — it is the preferred final deliverable. Charts you include " +
              "here are rendered server-side as crisp PNGs so they look identical in chat and PDF.",
            inputSchema: z.object({
              title: z.string().min(3).max(160),
              executive_summary: z.string().min(20).max(2000),
              key_findings: z.array(z.string().min(3).max(500)).min(1).max(10),
              sections: z
                .array(
                  z.object({
                    heading: z.string().min(2).max(160),
                    prose: z.string().max(4000).optional(),
                    bullets: z.array(z.string().min(2).max(500)).max(15).optional(),
                    chart: z
                      .object({
                        type: z.enum(["bar", "line", "pie", "doughnut"]),
                        title: z.string().max(160).optional(),
                        labels: z.array(z.string()).min(1).max(30),
                        datasets: z
                          .array(
                            z.object({
                              label: z.string().min(1).max(80),
                              data: z.array(z.number()).min(1).max(30),
                            }),
                          )
                          .min(1)
                          .max(4),
                      })
                      .optional(),
                  }),
                )
                .min(1)
                .max(8),
              recommendations: z.array(z.string().min(3).max(500)).max(8).optional(),
              caveats: z.array(z.string().min(3).max(500)).max(8).optional(),
            }),
            execute: async (input) => {
              // Pre-build QuickChart URLs server-side. The UI just renders them
              // as <img>, and the PDF exporter fetches them as PNGs.
              const sections = input.sections.map((s) => {
                if (!s.chart) return s;
                const chartUrl = buildQuickChartUrl(s.chart);
                return { ...s, chartUrl };
              });
              return {
                ...input,
                sections,
                generatedAt: new Date().toISOString(),
              };
            },
          }),
        };

        const gateway = createLovableAiGatewayProvider(key);
        const result = streamText({
          model: gateway("google/gemini-2.5-pro"),
          system: fullSystem,
          messages: await convertToModelMessages(messages),
          tools,
          stopWhen: stepCountIs(50),
        });

        // Capture the last user message up-front so the auto-extract callback
        // can see it without re-walking the UIMessage list later.
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        const lastUserText = ((lastUserMsg?.parts ?? []) as Array<Record<string, unknown>>)
          .filter((p) => p?.type === "text")
          .map((p) => String(p.text ?? ""))
          .join("\n")
          .trim();
        const existingMemoryContents = (memoryRows ?? []).map((m) => m.content);

        return result.toUIMessageStreamResponse({
          originalMessages: messages,
          onFinish: async ({ responseMessage }) => {
            const assistantText = (responseMessage.parts ?? [])
              .filter((p): p is { type: "text"; text: string } =>
                (p as { type?: string })?.type === "text",
              )
              .map((p) => p.text)
              .join("\n")
              .trim();
            if (!assistantText || !lastUserText) return;
            try {
              await autoExtractMemory({
                admin: adminClient,
                apiKey: key,
                userMessage: lastUserText,
                assistantText,
                existingMemoryContents,
                createdBy: auth.userId,
              });
            } catch (e) {
              console.warn("autoExtractMemory failed", e);
            }
          },
        });

      },
    },
  },
});
