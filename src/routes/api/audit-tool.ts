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

const SYSTEM_PROMPT = `You are an expert data analyst for the Salisbury DGH Anaesthetics
Department rota application. The current user is an ADMIN. Your job is to take a plain-English
audit or data-analysis request and turn it into a clear report.

WORKFLOW
1. Restate the request in one sentence so we are aligned.
2. Ask any clarifying questions you genuinely need (date ranges, which staff/grades to include,
   how to handle leave/sickness, whether to exclude inactive staff, grouping, definitions of
   "shift" / "hours" / "session" etc.). Ask 1–3 focused questions at a time, not a long list.
3. Once you have enough information, use the \`describe_schema\` tool to inspect the relevant
   tables (NEVER guess column names). Then call \`run_sql\` with a single read-only SELECT/WITH
   query and a short human-readable \`title\`. You may call \`run_sql\` multiple times if the
   report needs several views. If a chart would help, include a \`chart\` spec.
4. After running queries, write a concise narrative summary in markdown explaining what the
   data shows, any caveats, and notable patterns. Reference the queries by their titles.

QUERY RULES
- Single statement, SELECT or WITH only. No semicolons inside. No DDL/DML.
- Schema is \`public\`. Use \`information_schema\` via the \`describe_schema\` tool, not in \`run_sql\`.
- Always alias aggregate columns (e.g. \`COUNT(*) AS sessions\`).
- Order results sensibly. Limit to the top N rows when there could be many — the system
  hard-caps at 5000 rows regardless.
- For per-week / per-month aggregations, use \`date_trunc('week', session_date)\` etc.
- Dates are stored as \`date\`. \`session\` is an enum: am, pm, eve, night, long_day.
- Sessions 'am' and 'pm' are nominally 5h each. 'eve' is ~3h. 'long_day' is ~10h.
  'night' is ~13h. These are conventions for this department.

KEY TABLES (quick reference — confirm columns with describe_schema before querying)
- profiles: id, full_name, email, grade, training_level, active, rotation_end_date
- rota_assignments: id, staff_id, session_date, session, role_on_list, duty_type,
  theatre_session_id, supervisor_id, source, notes
- leave_requests: id, staff_id, leave_type, start_date, end_date, status, decided_at, notes
- leave_allowances: id, staff_id, leave_year_start, leave_type, allowance_days, carried_over_days
- job_plans: id, staff_id, total_pas, dcc_pas, spa_pas, ltft, ltft_percentage, valid_from, valid_to
- theatre_sessions, theatres, specialties: theatre context
- user_roles: user_id, role (do NOT query auth schema)

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
