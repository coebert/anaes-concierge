CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own push subscriptions"
  ON public.push_subscriptions FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.push_notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_log_id uuid NOT NULL REFERENCES public.rota_change_log(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.push_subscriptions(id) ON DELETE SET NULL,
  staff_id uuid NOT NULL,
  status text NOT NULL,
  error text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_log_id, subscription_id)
);

CREATE INDEX push_notification_log_change_log_idx ON public.push_notification_log(change_log_id);

GRANT SELECT ON public.push_notification_log TO authenticated;
GRANT ALL ON public.push_notification_log TO service_role;

ALTER TABLE public.push_notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view push notification log"
  ON public.push_notification_log FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));