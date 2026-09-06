-- passkey_challenges: strictly service-role / SECURITY DEFINER only.
REVOKE ALL ON TABLE public.passkey_challenges FROM anon, authenticated;
GRANT ALL ON TABLE public.passkey_challenges TO service_role;

-- icu_audit_job_state: coordinators/admins may read (existing SELECT policy);
-- writes only via the scheduled job running as service_role.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.icu_audit_job_state FROM anon, authenticated;
GRANT ALL ON TABLE public.icu_audit_job_state TO service_role;

-- leave_change_log: append-only audit trail written by SECURITY DEFINER
-- trigger / service_role; client roles must never write.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.leave_change_log FROM anon, authenticated;
GRANT ALL ON TABLE public.leave_change_log TO service_role;