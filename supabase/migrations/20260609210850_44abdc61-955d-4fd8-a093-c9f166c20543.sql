CREATE TABLE IF NOT EXISTS public.audit_assistant_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('lesson','preference','fact','correction')),
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_assistant_memories_created_at_idx
  ON public.audit_assistant_memories (created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_assistant_memories TO authenticated;
GRANT ALL ON public.audit_assistant_memories TO service_role;

ALTER TABLE public.audit_assistant_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can read memories"
  ON public.audit_assistant_memories FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admins can insert memories"
  ON public.audit_assistant_memories FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admins can update memories"
  ON public.audit_assistant_memories FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admins can delete memories"
  ON public.audit_assistant_memories FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));