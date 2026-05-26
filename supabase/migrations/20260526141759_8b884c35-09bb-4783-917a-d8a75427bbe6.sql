-- 1. Profiles: column-level read access
REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (
  id, full_name, grade, training_level, active,
  ltft_days_off, start_date, rotation_end_date,
  clwrota_external_id, created_at, updated_at
) ON public.profiles TO authenticated;

-- 2. custom_rota_rules: scoped SELECT policy
DROP POLICY IF EXISTS "Authenticated read custom rules" ON public.custom_rota_rules;

CREATE POLICY "Read dept/grade rules, own staff rules, or coord/admin all"
ON public.custom_rota_rules
FOR SELECT
TO authenticated
USING (
  scope IN ('department'::custom_rule_scope, 'grade'::custom_rule_scope)
  OR (scope = 'staff'::custom_rule_scope AND staff_id = auth.uid())
  OR public.current_user_is_coordinator_or_admin()
);
