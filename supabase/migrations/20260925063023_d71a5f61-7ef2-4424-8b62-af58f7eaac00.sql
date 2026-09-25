DROP INDEX IF EXISTS public.push_notification_log_leave_unique;
CREATE UNIQUE INDEX push_notification_log_leave_unique ON public.push_notification_log (leave_change_log_id, subscription_id);
INSERT INTO public.push_notification_log (leave_change_log_id, subscription_id, staff_id, status)
SELECT l.id, NULL, l.staff_id, 'suppressed_duplicate_fix'
FROM public.leave_change_log l
WHERE NOT EXISTS (SELECT 1 FROM public.push_notification_log p WHERE p.leave_change_log_id = l.id);