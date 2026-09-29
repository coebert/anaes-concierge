CREATE OR REPLACE FUNCTION public.get_rtw_interviews_decrypted()
RETURNS TABLE(id uuid, leave_request_id uuid, staff_id uuid, conducted_by uuid, conducted_at timestamptz, fitness_confirmed boolean, reasonable_adjustments text, follow_up_required boolean, follow_up_date date, notes text, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT r.id, r.leave_request_id, r.staff_id, r.conducted_by, r.conducted_at,
    r.fitness_confirmed,
    public.decrypt_owner_or_coord(r.reasonable_adjustments_enc, r.staff_id),
    r.follow_up_required, r.follow_up_date,
    public.decrypt_owner_or_coord(r.notes_enc, r.staff_id),
    r.created_at, r.updated_at
  FROM public.return_to_work_interviews r
  WHERE current_user = 'service_role'
     OR pg_has_role(current_user, 'service_role', 'MEMBER')
     OR r.staff_id = auth.uid()
     OR public.current_user_is_coordinator_or_admin();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_rtw_interviews_decrypted', v_rows, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_ai_messages_decrypted(p_conversation_id uuid)
RETURNS TABLE(id uuid, conversation_id uuid, user_id uuid, role chat_role, parts jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT m.id, m.conversation_id, m.user_id, m.role,
    public.decrypt_ai_message_parts(m.parts_enc, m.conversation_id),
    m.created_at
  FROM public.ai_messages m
  JOIN public.ai_conversations c ON c.id = m.conversation_id
  WHERE m.conversation_id = p_conversation_id
    AND (current_user = 'service_role'
         OR pg_has_role(current_user, 'service_role', 'MEMBER')
         OR c.user_id = auth.uid()
         OR public.current_user_is_coordinator_or_admin())
  ORDER BY m.created_at ASC
$$;