import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { generateText, Output } from "ai";
import { z } from "zod";

const CheckInput = z.object({
  staffId: z.string().uuid(),
  date: z.string(),
  session: z.enum(["am", "pm"]),
  role: z.string(),
  /** Recent surrounding assignments for the same staff (last 14d / next 14d). */
  contextAssignments: z
    .array(
      z.object({
        session_date: z.string(),
        session: z.string(),
        role_on_list: z.string(),
      }),
    )
    .max(200),
});

export type CustomRuleViolation = {
  ruleId: string;
  summary: string;
  ruleText: string;
  reason: string;
};

export const checkCustomRuleViolations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CheckInput.parse(input))
  .handler(async ({ data, context }): Promise<{ violations: CustomRuleViolation[] }> => {
    const { userId } = context;

    // Admin gate
    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return { violations: [] };

    // Resolve staff profile (grade)
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, grade")
      .eq("id", data.staffId)
      .maybeSingle();
    if (!profile) return { violations: [] };

    // Fetch applicable rules
    const { data: rules } = await supabaseAdmin
      .from("custom_rota_rules")
      .select("id, scope, staff_id, grade, rule_text, summary")
      .eq("active", true);
    if (!rules?.length) return { violations: [] };

    const applicable = rules.filter((r) => {
      if (r.scope === "department") return true;
      if (r.scope === "staff") return r.staff_id === data.staffId;
      if (r.scope === "grade") return r.grade && profile.grade && r.grade === profile.grade;
      return false;
    });
    if (!applicable.length) return { violations: [] };

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { violations: [] };

    const gateway = createLovableAiGatewayProvider(apiKey);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `You are checking whether a proposed rota assignment violates any custom working-pattern rules.

Staff member: ${profile.full_name} (grade: ${profile.grade ?? "unknown"})
Proposed assignment: date ${data.date}, session ${data.session.toUpperCase()}, role ${data.role}

Surrounding assignments for this staff member (date, session, role):
${data.contextAssignments
  .sort((a, b) => (a.session_date < b.session_date ? -1 : 1))
  .map((a) => `- ${a.session_date} ${a.session.toUpperCase()} ${a.role_on_list}`)
  .join("\n") || "(none)"}

Active custom rules to check (id | summary | rule):
${applicable.map((r) => `${r.id} | ${r.summary} | ${r.rule_text}`).join("\n")}

For each rule, decide if the proposed assignment, taken together with the surrounding assignments, breaks the rule. Be strict: only flag a clear violation. Respond with an array of { ruleId, violated, reason } — reason is one short sentence explaining the violation (or why not).`;

    try {
      const { experimental_output } = await generateText({
        model,
        prompt,
        experimental_output: Output.object({
          schema: z.object({
            results: z.array(
              z.object({
                ruleId: z.string(),
                violated: z.boolean(),
                reason: z.string(),
              }),
            ),
          }),
        }),
      });

      const ruleMap = new Map(applicable.map((r) => [r.id, r]));
      const violations: CustomRuleViolation[] = (experimental_output?.results ?? [])
        .filter((r) => r.violated && ruleMap.has(r.ruleId))
        .map((r) => {
          const rule = ruleMap.get(r.ruleId)!;
          return {
            ruleId: r.ruleId,
            summary: rule.summary,
            ruleText: rule.rule_text,
            reason: r.reason,
          };
        });
      return { violations };
    } catch (e) {
      console.error("checkCustomRuleViolations failed", e);
      return { violations: [] };
    }
  });
