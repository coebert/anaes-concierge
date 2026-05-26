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
If the user asks about something outside the app's data, say so and suggest who to contact.`;

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

function buildTools(userId: string) {
  const admin = getAdminClient();
  return {
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
              supervisor: a.supervisor_id ? supMap.get(a.supervisor_id) ?? null : null,
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
      description: "Find who is on-call across the department today.",
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
            name: pmap.get(r.staff_id)?.full_name ?? "Unknown",
            grade: pmap.get(r.staff_id)?.grade ?? null,
            session: r.session,
            notes: r.notes,
          })),
        };
      },
    }),
  };
}

const ChatBody = z.object({
  messages: z.array(z.any()),
  conversationId: z.string().uuid(),
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
          body = ChatBody.parse(await request.json());
        } catch {
          return new Response("Invalid body", { status: 400 });
        }
        const { messages, conversationId } = body;
        const uiMessages = messages as UIMessage[];

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

        const result = streamText({
          model,
          system: SYSTEM_PROMPT,
          messages: await convertToModelMessages(uiMessages),
          tools: buildTools(userId),
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
