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
import { sendGmail } from "@/lib/gmail.server";

const SYSTEM_PROMPT = `You are the AI assistant for the Salisbury DGH Anaesthetics Department rota app.
You help staff understand their rota, leave entitlement, leave requests and trainee progress.
Be concise and use markdown. Dates should be human-friendly (e.g. "Mon 2 Jun"). Always call the relevant
tool before answering questions about the current user's rota, leave or pending requests — never guess.
If the user asks about something outside the app's data, say so and suggest who to contact.

ADMIN MUTATIONS: If (and only if) the calling user is an admin, you have additional tools to make
changes: create/update/delete rota assignments, update job plans (PAs, LTFT status and percentage),
update staff profile details (grade, training level, active status), and manage CUSTOM WORKING-PATTERN
RULES that the department wants you to remember (e.g. "Dr Smith always has the morning off after an
overnight on-call"). Use \`find_staff\` to resolve names to staff IDs before calling a mutation.
Always confirm the intended change in your reply, state what was changed, and warn about any potential
TCS, double-booking or custom-rule implications you notice.

CUSTOM RULES: When an admin states a working-pattern rule, call \`create_custom_rule\` to persist it.
Always factor the CURRENT CUSTOM RULES (listed below if any) into any rota writing or amendments you
suggest or make. If asked to break one, push back and ask the admin to confirm. If the user is not an
admin and asks for a change, politely explain you cannot make changes for them.`;


function getAdminClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function getAuthenticatedUserId(authHeader: string | null) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(iso: string, n: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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

async function isCoordinatorOrAdmin(userId: string) {
  const admin = getAdminClient();
  const { data } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "rota_coordinator"]);
  return (data ?? []).length > 0;
}

function buildAdminTools() {
  const admin = getAdminClient();
  return {
    find_staff: tool({
      description:
        "Find staff members by name or email (case-insensitive partial match). Returns id, name, email, grade, training level and active flag. Use this to resolve a person to a staff_id before calling a mutation tool.",
      inputSchema: z.object({
        query: z.string().min(1).max(120),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, limit }) => {
        const q = `%${query}%`;
        const { data, error } = await admin
          .from("profiles")
          .select("id,full_name,email,grade,training_level,active")
          .or(`full_name.ilike.${q},email.ilike.${q}`)
          .limit(limit ?? 10);
        if (error) return { error: error.message };
        return { staff: data ?? [] };
      },
    }),

    create_rota_assignment: tool({
      description:
        "ADMIN ONLY. Create a single rota assignment for a staff member on a specific date/session. The DB unique constraint prevents double-booking the same staff member on the same date+session.",
      inputSchema: z.object({
        staff_id: z.string().uuid(),
        session_date: z.string().describe("ISO date YYYY-MM-DD"),
        session: z.enum(["am", "pm", "eve", "night", "long_day"]).describe("Session slot"),
        role_on_list: z
          .enum(["solo", "supervised", "supervisor", "on_call", "teaching", "admin"])
          .optional(),
        theatre_session_id: z.string().uuid().optional(),
        supervisor_id: z.string().uuid().optional(),
        notes: z.string().max(500).optional(),
      }),
      execute: async (input) => {
        const { data, error } = await admin
          .from("rota_assignments")
          .insert({
            staff_id: input.staff_id,
            session_date: input.session_date,
            session: input.session,
            role_on_list: input.role_on_list ?? "solo",
            theatre_session_id: input.theatre_session_id ?? null,
            supervisor_id: input.supervisor_id ?? null,
            notes: input.notes ?? null,
            source: "manual",
          })
          .select("id")
          .maybeSingle();
        if (error) return { error: error.message };
        return { ok: true, id: data?.id };
      },
    }),

    update_rota_assignment: tool({
      description:
        "ADMIN ONLY. Update an existing rota assignment (e.g. move it to a different theatre, change role, reassign to another staff member, change notes).",
      inputSchema: z.object({
        id: z.string().uuid(),
        staff_id: z.string().uuid().optional(),
        session_date: z.string().optional(),
        session: z.enum(["am", "pm", "eve", "night", "long_day"]).optional(),
        role_on_list: z
          .enum(["solo", "supervised", "supervisor", "on_call", "teaching", "admin"])
          .optional(),
        theatre_session_id: z.string().uuid().nullable().optional(),
        supervisor_id: z.string().uuid().nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
      }),
      execute: async ({ id, ...patch }) => {
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        if (!Object.keys(clean).length) return { error: "No fields to update" };
        const { error } = await admin.from("rota_assignments").update(clean).eq("id", id);
        if (error) return { error: error.message };
        return { ok: true };
      },
    }),

    delete_rota_assignment: tool({
      description: "ADMIN ONLY. Delete a rota assignment by id.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        const { error } = await admin.from("rota_assignments").delete().eq("id", id);
        if (error) return { error: error.message };
        return { ok: true };
      },
    }),

    find_rota_assignments: tool({
      description:
        "ADMIN ONLY. Look up rota assignments by staff_id and/or date range to find the id needed for update/delete.",
      inputSchema: z.object({
        staff_id: z.string().uuid().optional(),
        from: z.string().describe("ISO date YYYY-MM-DD"),
        to: z.string().describe("ISO date YYYY-MM-DD"),
      }),
      execute: async ({ staff_id, from, to }) => {
        let q = admin
          .from("rota_assignments")
          .select("id,staff_id,session_date,session,role_on_list,theatre_session_id,notes")
          .gte("session_date", from)
          .lte("session_date", to)
          .order("session_date");
        if (staff_id) q = q.eq("staff_id", staff_id);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { assignments: data ?? [] };
      },
    }),

    update_job_plan: tool({
      description:
        "ADMIN ONLY. Update a staff member's current job plan: total/DCC/SPA PAs, LTFT status and percentage, on-call commitment, notes. Updates the most recent active job plan; if none exists a new one is created.",
      inputSchema: z.object({
        staff_id: z.string().uuid(),
        total_pas: z.number().min(0).max(20).optional(),
        dcc_pas: z.number().min(0).max(20).optional(),
        spa_pas: z.number().min(0).max(20).optional(),
        ltft: z.boolean().optional(),
        ltft_percentage: z.number().min(0).max(100).nullable().optional(),
        on_call_commitment: z.string().max(200).nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
      }),
      execute: async ({ staff_id, ...patch }) => {
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        if (!Object.keys(clean).length) return { error: "No fields to update" };
        const today = todayISO();
        const { data: existing } = await admin
          .from("job_plans")
          .select("id")
          .eq("staff_id", staff_id)
          .lte("valid_from", today)
          .or(`valid_to.is.null,valid_to.gte.${today}`)
          .order("valid_from", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existing?.id) {
          const { error } = await admin.from("job_plans").update(clean).eq("id", existing.id);
          if (error) return { error: error.message };
          return { ok: true, id: existing.id, action: "updated" };
        }
        const { data, error } = await admin
          .from("job_plans")
          .insert({ staff_id, ...clean })
          .select("id")
          .maybeSingle();
        if (error) return { error: error.message };
        return { ok: true, id: data?.id, action: "created" };
      },
    }),

    update_staff_profile: tool({
      description:
        "ADMIN ONLY. Update a staff member's profile fields: grade (consultant/sas/trainee), training_level (e.g. ST4), full_name, active flag.",
      inputSchema: z.object({
        staff_id: z.string().uuid(),
        full_name: z.string().min(1).max(200).optional(),
        grade: z.enum(["consultant", "sas", "trainee"]).nullable().optional(),
        training_level: z
          .enum(["CT1", "CT2", "CT3", "ACCS1", "ACCS2", "ACCS3", "ST4", "ST5", "ST6", "ST7", "ST8", "ST8+"])
          .nullable()
          .optional(),
        active: z.boolean().optional(),
      }),
      execute: async ({ staff_id, ...patch }) => {
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        if (!Object.keys(clean).length) return { error: "No fields to update" };
        const { error } = await admin.from("profiles").update(clean).eq("id", staff_id);
        if (error) return { error: error.message };
        return { ok: true };
      },
    }),

    list_custom_rules: tool({
      description:
        "ADMIN ONLY. List the active custom working-pattern rules. Optionally filter by staff_id or grade.",
      inputSchema: z.object({
        staff_id: z.string().uuid().optional(),
        grade: z.enum(["consultant", "sas", "trainee"]).optional(),
      }),
      execute: async ({ staff_id, grade }) => {
        let q = admin
          .from("custom_rota_rules")
          .select("id,scope,staff_id,grade,summary,rule_text,active,created_at")
          .eq("active", true)
          .order("created_at", { ascending: false });
        if (staff_id) q = q.or(`staff_id.eq.${staff_id},scope.eq.department`);
        if (grade) q = q.or(`grade.eq.${grade},scope.eq.department`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { rules: data ?? [] };
      },
    }),

    create_custom_rule: tool({
      description:
        "ADMIN ONLY. Persist a new custom working-pattern rule so it is remembered across sessions and factored into future rota work. Scope is 'staff' (one person), 'grade' (e.g. all trainees), or 'department' (everyone). Provide a short `summary` (≤80 chars) for display and the full `rule_text` capturing the rule.",
      inputSchema: z.object({
        scope: z.enum(["staff", "grade", "department"]),
        staff_id: z.string().uuid().optional(),
        grade: z.enum(["consultant", "sas", "trainee"]).optional(),
        summary: z.string().min(3).max(120),
        rule_text: z.string().min(5).max(1000),
      }),
      execute: async (input) => {
        if (input.scope === "staff" && !input.staff_id)
          return { error: "staff_id is required when scope is 'staff'" };
        if (input.scope === "grade" && !input.grade)
          return { error: "grade is required when scope is 'grade'" };
        const { data, error } = await admin
          .from("custom_rota_rules")
          .insert({
            scope: input.scope,
            staff_id: input.scope === "staff" ? input.staff_id : null,
            grade: input.scope === "grade" ? input.grade : null,
            summary: input.summary,
            rule_text: input.rule_text,
          })
          .select("id")
          .maybeSingle();
        if (error) return { error: error.message };
        return { ok: true, id: data?.id };
      },
    }),

    update_custom_rule: tool({
      description:
        "ADMIN ONLY. Edit an existing custom rule (summary, rule_text, active flag).",
      inputSchema: z.object({
        id: z.string().uuid(),
        summary: z.string().min(3).max(120).optional(),
        rule_text: z.string().min(5).max(1000).optional(),
        active: z.boolean().optional(),
      }),
      execute: async ({ id, ...patch }) => {
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        if (!Object.keys(clean).length) return { error: "No fields to update" };
        const { error } = await admin.from("custom_rota_rules").update(clean).eq("id", id);
        if (error) return { error: error.message };
        return { ok: true };
      },
    }),

    delete_custom_rule: tool({
      description: "ADMIN ONLY. Remove a custom working-pattern rule by id.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        const { error } = await admin.from("custom_rota_rules").delete().eq("id", id);
        if (error) return { error: error.message };
        return { ok: true };
      },
    }),
  };
}

async function buildAdminCustomRulesPreamble(): Promise<string> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("custom_rota_rules")
    .select("id,scope,staff_id,grade,summary,rule_text")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(200);
  if (!data?.length) return "";
  const staffIds = Array.from(
    new Set(data.filter((r) => r.staff_id).map((r) => r.staff_id as string)),
  );
  const nameMap = new Map<string, string>();
  if (staffIds.length) {
    const { data: profs } = await admin
      .from("profiles")
      .select("id,full_name")
      .in("id", staffIds);
    for (const p of profs ?? []) nameMap.set(p.id, p.full_name);
  }
  const lines = data.map((r) => {
    const who =
      r.scope === "staff"
        ? `[${nameMap.get(r.staff_id ?? "") ?? "unknown staff"}]`
        : r.scope === "grade"
          ? `[grade: ${r.grade}]`
          : "[department]";
    return `- ${who} ${r.summary} — ${r.rule_text}`;
  });
  return `\n\nCURRENT CUSTOM RULES (factor these into any rota suggestions or edits):\n${lines.join("\n")}`;
}


function buildTools(userId: string, isAdminUser: boolean, canSeeColleagueNames: boolean) {
  const admin = getAdminClient();
  const baseTools = {
    get_my_upcoming_rota: tool({
      description:
        "Get the signed-in user's upcoming rota assignments (theatre lists, on-call, teaching, admin). Defaults to the next 14 days.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).optional(),
      }),
      execute: async ({ days }) => {
        const from = todayISO();
        const to = addDays(from, days ?? 14);
        const { data, error } = await admin
          .from("rota_assignments")
          .select(
            "session_date,session,role_on_list,notes,theatre_session_id,supervisor_id",
          )
          .eq("staff_id", userId)
          .gte("session_date", from)
          .lte("session_date", to)
          .order("session_date");
        if (error) return { error: error.message };
        const tsIds = Array.from(
          new Set(
            (data ?? []).map((r) => r.theatre_session_id).filter(Boolean) as string[],
          ),
        );
        const supIds = Array.from(
          new Set(
            (data ?? []).map((r) => r.supervisor_id).filter(Boolean) as string[],
          ),
        );
        const [{ data: ts }, { data: sups }] = await Promise.all([
          tsIds.length
            ? admin
                .from("theatre_sessions")
                .select("id,theatre_id,specialty_id,surgical_consultant")
                .in("id", tsIds)
            : Promise.resolve({ data: [] as any[] }),
          supIds.length
            ? admin.from("profiles").select("id,full_name").in("id", supIds)
            : Promise.resolve({ data: [] as any[] }),
        ]);
        const theatreIds = Array.from(
          new Set((ts ?? []).map((t: any) => t.theatre_id).filter(Boolean)),
        );
        const specIds = Array.from(
          new Set((ts ?? []).map((t: any) => t.specialty_id).filter(Boolean)),
        );
        const [{ data: theatres }, { data: specs }] = await Promise.all([
          theatreIds.length
            ? admin.from("theatres").select("id,name").in("id", theatreIds)
            : Promise.resolve({ data: [] as any[] }),
          specIds.length
            ? admin.from("specialties").select("id,name").in("id", specIds)
            : Promise.resolve({ data: [] as any[] }),
        ]);
        const tsMap = new Map((ts ?? []).map((t: any) => [t.id, t]));
        const theatreMap = new Map((theatres ?? []).map((t: any) => [t.id, t.name]));
        const specMap = new Map((specs ?? []).map((s: any) => [s.id, s.name]));
        const supMap = new Map((sups ?? []).map((s: any) => [s.id, s.full_name]));
        return {
          range: { from, to },
          assignments: (data ?? []).map((a) => {
            const ts = a.theatre_session_id ? tsMap.get(a.theatre_session_id) : null;
            return {
              date: a.session_date,
              session: a.session,
              role: a.role_on_list,
              theatre: ts ? theatreMap.get(ts.theatre_id) ?? null : null,
              specialty: ts?.specialty_id ? specMap.get(ts.specialty_id) ?? null : null,
              surgeon: ts?.surgical_consultant ?? null,
              supervisor: a.supervisor_id
                ? canSeeColleagueNames
                  ? supMap.get(a.supervisor_id) ?? null
                  : "Withheld"
                : null,
              notes: a.notes,
            };
          }),
        };
      },
    }),

    get_my_leave_summary: tool({
      description:
        "Get the signed-in user's leave allowance and a list of their leave requests (pending, approved, rejected).",
      inputSchema: z.object({}),
      execute: async () => {
        const [{ data: allowance }, { data: requests }] = await Promise.all([
          admin
            .from("leave_allowances")
            .select("annual_days,study_days,leave_year_start")
            .eq("staff_id", userId)
            .maybeSingle(),
          admin
            .from("leave_requests")
            .select("type,start_date,end_date,status,half_day_start,half_day_end,reason,decision_notes")
            .eq("staff_id", userId)
            .order("start_date", { ascending: false })
            .limit(50),
        ]);
        return { allowance, requests };
      },
    }),

    get_team_on_call_today: tool({
      description:
        canSeeColleagueNames
          ? "Find who is on-call across the department today (names, grades, sessions)."
          : "Count on-call cover across the department today. Returns grades and sessions only — colleague names are restricted to coordinators/admins.",
      inputSchema: z.object({}),
      execute: async () => {
        const today = todayISO();
        const { data, error } = await admin
          .from("rota_assignments")
          .select("staff_id,session,notes")
          .eq("session_date", today)
          .eq("role_on_list", "on_call");
        if (error) return { error: error.message };
        const ids = (data ?? []).map((r) => r.staff_id);
        const { data: profs } = ids.length
          ? await admin.from("profiles").select("id,full_name,grade").in("id", ids)
          : { data: [] as any[] };
        const pmap = new Map((profs ?? []).map((p: any) => [p.id, p]));
        return {
          date: today,
          on_call: (data ?? []).map((r) => ({
            name: canSeeColleagueNames
              ? pmap.get(r.staff_id)?.full_name ?? "Unknown"
              : "Withheld",
            grade: pmap.get(r.staff_id)?.grade ?? null,
            session: r.session,
            notes: canSeeColleagueNames ? r.notes : null,
          })),
        };
      },
    }),
  };
  return isAdminUser ? { ...baseTools, ...buildAdminTools() } : baseTools;
}


const ChatMessage = z.object({
  id: z.string().optional(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.record(z.any())).optional(),
  content: z.string().optional(),
}).passthrough();

const ChatBody = z.object({
  messages: z.array(ChatMessage)
    .min(1, "Please type a message before sending.")
    .max(500, "This conversation is too long — please start a new chat."),
  conversationId: z.string({
    required_error: "Missing conversation — please open or start a chat first.",
    invalid_type_error: "Missing conversation — please open or start a chat first.",
  }).uuid("The conversation reference is invalid — please start a new chat."),
});

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await getAuthenticatedUserId(
          request.headers.get("authorization"),
        );
        if (!userId) return new Response("Unauthorized", { status: 401 });

        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) {
          return new Response("Missing LOVABLE_API_KEY", { status: 500 });
        }

        let body: z.infer<typeof ChatBody>;
        try {
          const raw = await request.json();
          body = ChatBody.parse(raw);
        } catch (e) {
          const friendly = e instanceof z.ZodError
            ? e.errors.slice(0, 3).map((x) => {
                const field = x.path.join(".") || "request";
                return `“${field}”: ${x.message}`;
              }).join("; ")
            : "The request body wasn't valid JSON.";
          return new Response(`We couldn't send your message. ${friendly}`, { status: 400 });
        }

        const { messages, conversationId } = body;
        const uiMessages = messages as unknown as UIMessage[];

        const admin = getAdminClient();
        // Confirm conversation belongs to user
        const { data: conv } = await admin
          .from("ai_conversations")
          .select("id,user_id,title")
          .eq("id", conversationId)
          .maybeSingle();
        if (!conv || conv.user_id !== userId) {
          return new Response("Forbidden", { status: 403 });
        }

        // Persist the latest user message if it isn't saved yet
        const lastMsg = uiMessages[uiMessages.length - 1];
        if (lastMsg?.role === "user") {
          await admin.from("ai_messages").insert({
            conversation_id: conversationId,
            user_id: userId,
            role: "user",
            parts: lastMsg.parts ?? [],
          });

          // If conversation still has the default title, derive one from the first user message
          if (conv.title === "New conversation") {
            const text = (lastMsg.parts ?? [])
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join(" ")
              .trim();
            if (text) {
              await admin
                .from("ai_conversations")
                .update({ title: text.slice(0, 60) })
                .eq("id", conversationId);
            }
          }
        }

        const gateway = createLovableAiGatewayProvider(apiKey);
        const model = gateway("google/gemini-3-flash-preview");

        const adminUser = await isAdmin(userId);
        const canSeeColleagueNames = adminUser || (await isCoordinatorOrAdmin(userId));
        const rulesPreamble = adminUser ? await buildAdminCustomRulesPreamble() : "";
        const privacyPreamble = canSeeColleagueNames
          ? ""
          : "\n\nPRIVACY: The current user is NOT a coordinator or admin. You MUST NOT reveal, guess, or infer the names of other staff members. If a tool returns a name as 'Withheld', report it as withheld; never substitute a real name. Decline politely if the user asks you to identify a colleague (e.g. 'who is on call?', 'who supervised me?', 'who is in theatre 3?'), and suggest they contact a rota coordinator.";

        const result = streamText({
          model,
          system: SYSTEM_PROMPT + rulesPreamble + privacyPreamble,
          messages: await convertToModelMessages(uiMessages),
          tools: buildTools(userId, adminUser, canSeeColleagueNames),
          stopWhen: stepCountIs(50),
        });


        return result.toUIMessageStreamResponse({
          originalMessages: uiMessages,
          onFinish: async ({ responseMessage }) => {
            try {
              await admin.from("ai_messages").insert({
                conversation_id: conversationId,
                user_id: userId,
                role: "assistant",
                parts: responseMessage.parts ?? [],
              });
              await admin
                .from("ai_conversations")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", conversationId);
            } catch (e) {
              console.error("Failed to persist assistant message", e);
            }

            // Email the assistant's text reply to the user
            try {
              const text = (responseMessage.parts ?? [])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text as string)
                .join("\n\n")
                .trim();
              if (!text) return;

              const { data: prof } = await admin
                .from("profiles")
                .select("email,full_name")
                .eq("id", userId)
                .maybeSingle();
              const recipient = prof?.email;
              if (!recipient) return;

              const lastUser = [...uiMessages]
                .reverse()
                .find((m: any) => m.role === "user");
              const question = ((lastUser?.parts ?? []) as any[])
                .filter((p) => p.type === "text")
                .map((p) => p.text as string)
                .join(" ")
                .trim();
              const subject = question
                ? `Re: ${question.slice(0, 60)}${question.length > 60 ? "…" : ""}`
                : "Your rota assistant reply";

              const safeQuestion = question
                ? question.replace(/[<>&]/g, (c) =>
                    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
                  )
                : "";
              const safeAnswer = text.replace(/[<>&]/g, (c) =>
                c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
              );
              const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:640px">
  <p style="color:#555;font-size:13px;margin:0 0 4px">Salisbury DGH Anaesthetics Rota — AI assistant</p>
  ${safeQuestion ? `<blockquote style="border-left:3px solid #ddd;margin:0 0 16px;padding:6px 12px;color:#555;white-space:pre-wrap">${safeQuestion}</blockquote>` : ""}
  <div style="white-space:pre-wrap;line-height:1.5">${safeAnswer}</div>
</div>`;

              await sendGmail({
                to: recipient,
                subject,
                text,
                html,
              });
            } catch (e) {
              console.error("Failed to email assistant reply", e);
            }
          },
          onError: (err) => {
            console.error("Chat stream error", err);
            return "An error occurred. Please try again.";
          },
        });
      },
    },
  },
});
