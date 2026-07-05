
CREATE TABLE public.passkey_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[],
  device_name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.passkey_credentials TO authenticated;
GRANT ALL ON public.passkey_credentials TO service_role;
ALTER TABLE public.passkey_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own passkeys" ON public.passkey_credentials
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own passkeys" ON public.passkey_credentials
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own passkeys" ON public.passkey_credentials
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own passkeys" ON public.passkey_credentials
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX passkey_credentials_user_id_idx ON public.passkey_credentials(user_id);

CREATE TABLE public.passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email_hash bytea,
  challenge text not null,
  purpose text not null check (purpose in ('registration','authentication')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes')
);
GRANT ALL ON public.passkey_challenges TO service_role;
ALTER TABLE public.passkey_challenges ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated/anon: only service_role touches this table.
CREATE INDEX passkey_challenges_lookup_idx ON public.passkey_challenges(user_id, purpose, created_at DESC);
CREATE INDEX passkey_challenges_email_idx ON public.passkey_challenges(email_hash, purpose, created_at DESC);
