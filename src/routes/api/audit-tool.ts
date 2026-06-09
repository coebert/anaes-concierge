import { createFileRoute } from "@tanstack/react-router";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { createClient } from "@supabase/supabase-js";
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

        const body = (await request.json()) as { messages?: UIMessage[] };
        const messages = body.messages;
        if (!Array.isArray(messages)) {
          return new Response("Messages are required", { status: 400 });
        }

        const userClient = getUserClient(auth.token);


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
        };

        const gateway = createLovableAiGatewayProvider(key);
        const result = streamText({
          model: gateway("google/gemini-2.5-pro"),
          system: SYSTEM_PROMPT,
          messages: await convertToModelMessages(messages),
          tools,
          stopWhen: stepCountIs(50),
        });

        return result.toUIMessageStreamResponse({ originalMessages: messages });
      },
    },
  },
});
