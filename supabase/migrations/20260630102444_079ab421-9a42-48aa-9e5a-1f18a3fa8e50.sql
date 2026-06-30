
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. Vault keys (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'COLUMN_ENCRYPTION_KEY') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'),
      'COLUMN_ENCRYPTION_KEY', 'Project-wide passphrase for pgp_sym column encryption');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'COLUMN_HMAC_KEY') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'),
      'COLUMN_HMAC_KEY', 'Project-wide key for deterministic HMAC lookups on encrypted columns');
  END IF;
END $$;

-- 2. Internal key fetchers.
CREATE OR REPLACE FUNCTION public._enc_key()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'COLUMN_ENCRYPTION_KEY' LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._enc_key() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._hmac_key()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'COLUMN_HMAC_KEY' LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._hmac_key() FROM PUBLIC, anon, authenticated;

-- 3. Primitives.
CREATE OR REPLACE FUNCTION public.encrypt_text(p_plain text)
RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF p_plain IS NULL THEN RETURN NULL; END IF;
  RETURN extensions.pgp_sym_encrypt(p_plain, public._enc_key());
END $$;
REVOKE ALL ON FUNCTION public.encrypt_text(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.decrypt_text(p_cipher bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  RETURN extensions.pgp_sym_decrypt(p_cipher, public._enc_key());
END $$;
REVOKE ALL ON FUNCTION public.decrypt_text(bytea) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.encrypt_jsonb(p_plain jsonb)
RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF p_plain IS NULL THEN RETURN NULL; END IF;
  RETURN extensions.pgp_sym_encrypt(p_plain::text, public._enc_key());
END $$;
REVOKE ALL ON FUNCTION public.encrypt_jsonb(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.decrypt_jsonb(p_cipher bytea)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  RETURN extensions.pgp_sym_decrypt(p_cipher, public._enc_key())::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.decrypt_jsonb(bytea) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hmac_text(p_plain text)
RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF p_plain IS NULL OR length(p_plain) = 0 THEN RETURN NULL; END IF;
  RETURN extensions.hmac(lower(btrim(p_plain)), public._hmac_key(), 'sha256');
END $$;
GRANT EXECUTE ON FUNCTION public.hmac_text(text) TO authenticated, service_role;

-- 4. Access-controlled decrypt helpers.
CREATE OR REPLACE FUNCTION public.decrypt_owner_or_coord(p_cipher bytea, p_owner uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF auth.uid() = p_owner OR public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_text(p_cipher);
  END IF;
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION public.decrypt_owner_or_coord(bytea, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.decrypt_coord_only(p_cipher bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_text(p_cipher);
  END IF;
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION public.decrypt_coord_only(bytea) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.decrypt_ai_message_parts(p_cipher bytea, p_conversation_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  SELECT user_id INTO v_owner FROM public.ai_conversations WHERE id = p_conversation_id;
  IF auth.uid() = v_owner OR public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_jsonb(p_cipher);
  END IF;
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION public.decrypt_ai_message_parts(bytea, uuid) TO authenticated, service_role;

-- 5. New columns.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_enc bytea,
  ADD COLUMN IF NOT EXISTS email_hash bytea,
  ADD COLUMN IF NOT EXISTS gmc_number_enc bytea;

ALTER TABLE public.access_requests
  ADD COLUMN IF NOT EXISTS email_enc bytea,
  ADD COLUMN IF NOT EXISTS email_hash bytea;

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS reason_enc bytea,
  ADD COLUMN IF NOT EXISTS decision_notes_enc bytea,
  ADD COLUMN IF NOT EXISTS conflict_notes_enc bytea;

ALTER TABLE public.ai_messages
  ADD COLUMN IF NOT EXISTS parts_enc bytea;

CREATE INDEX IF NOT EXISTS profiles_email_hash_idx ON public.profiles (email_hash);
CREATE INDEX IF NOT EXISTS access_requests_email_hash_idx ON public.access_requests (email_hash);

-- 6. Backfill.
UPDATE public.profiles
   SET email_enc = public.encrypt_text(email),
       email_hash = public.hmac_text(email)
 WHERE email IS NOT NULL AND email_enc IS NULL;

UPDATE public.profiles
   SET gmc_number_enc = public.encrypt_text(gmc_number)
 WHERE gmc_number IS NOT NULL AND gmc_number_enc IS NULL;

UPDATE public.access_requests
   SET email_enc = public.encrypt_text(email),
       email_hash = public.hmac_text(email)
 WHERE email IS NOT NULL AND email_enc IS NULL;

UPDATE public.leave_requests
   SET reason_enc = public.encrypt_text(reason)
 WHERE reason IS NOT NULL AND reason_enc IS NULL;
UPDATE public.leave_requests
   SET decision_notes_enc = public.encrypt_text(decision_notes)
 WHERE decision_notes IS NOT NULL AND decision_notes_enc IS NULL;
UPDATE public.leave_requests
   SET conflict_notes_enc = public.encrypt_text(conflict_notes)
 WHERE conflict_notes IS NOT NULL AND conflict_notes_enc IS NULL;

UPDATE public.ai_messages
   SET parts_enc = public.encrypt_jsonb(parts)
 WHERE parts IS NOT NULL AND parts_enc IS NULL;

-- 7. Sync triggers (keep plaintext writes mirrored into _enc/_hash).
CREATE OR REPLACE FUNCTION public._sync_profiles_encryption()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_enc := public.encrypt_text(NEW.email);
    NEW.email_hash := public.hmac_text(NEW.email);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.gmc_number IS DISTINCT FROM OLD.gmc_number THEN
    NEW.gmc_number_enc := public.encrypt_text(NEW.gmc_number);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_sync_encryption ON public.profiles;
CREATE TRIGGER profiles_sync_encryption
  BEFORE INSERT OR UPDATE OF email, gmc_number ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._sync_profiles_encryption();

CREATE OR REPLACE FUNCTION public._sync_access_requests_encryption()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_enc := public.encrypt_text(NEW.email);
    NEW.email_hash := public.hmac_text(NEW.email);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS access_requests_sync_encryption ON public.access_requests;
CREATE TRIGGER access_requests_sync_encryption
  BEFORE INSERT OR UPDATE OF email ON public.access_requests
  FOR EACH ROW EXECUTE FUNCTION public._sync_access_requests_encryption();

CREATE OR REPLACE FUNCTION public._sync_leave_requests_encryption()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    NEW.reason_enc := public.encrypt_text(NEW.reason);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.decision_notes IS DISTINCT FROM OLD.decision_notes THEN
    NEW.decision_notes_enc := public.encrypt_text(NEW.decision_notes);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.conflict_notes IS DISTINCT FROM OLD.conflict_notes THEN
    NEW.conflict_notes_enc := public.encrypt_text(NEW.conflict_notes);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS leave_requests_sync_encryption ON public.leave_requests;
CREATE TRIGGER leave_requests_sync_encryption
  BEFORE INSERT OR UPDATE OF reason, decision_notes, conflict_notes ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public._sync_leave_requests_encryption();

CREATE OR REPLACE FUNCTION public._sync_ai_messages_encryption()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.parts IS DISTINCT FROM OLD.parts THEN
    NEW.parts_enc := public.encrypt_jsonb(NEW.parts);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_messages_sync_encryption ON public.ai_messages;
CREATE TRIGGER ai_messages_sync_encryption
  BEFORE INSERT OR UPDATE OF parts ON public.ai_messages
  FOR EACH ROW EXECUTE FUNCTION public._sync_ai_messages_encryption();
