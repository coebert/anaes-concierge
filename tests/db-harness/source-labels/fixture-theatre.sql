-- Synthetic theatre tables in the live shape (columns used by 0008) with the
-- live active-member read policy. Run as postgres so postgres OWNS them.
-- Never run against a real database. All data are synthetic.
CREATE TYPE public.session_half AS ENUM ('am','pm','eve','night');
CREATE TABLE public.theatres (id uuid PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.theatre_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date date NOT NULL,
  theatre_id uuid NOT NULL REFERENCES public.theatres(id),
  session public.session_half NOT NULL,
  surgical_consultant text,
  notes text,
  UNIQUE (session_date, theatre_id, session)
);
GRANT SELECT ON public.theatres, public.theatre_sessions TO authenticated;
GRANT ALL ON public.theatres, public.theatre_sessions TO service_role;
ALTER TABLE public.theatres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theatre_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_read_theatres ON public.theatres FOR SELECT TO authenticated USING (public.is_app_member(auth.uid()));
CREATE POLICY members_read_sessions ON public.theatre_sessions FOR SELECT TO authenticated USING (public.is_app_member(auth.uid()));

INSERT INTO public.theatres VALUES
 ('70000000-0000-0000-0000-000000000001','Synthetic Theatre 1',true),
 ('70000000-0000-0000-0000-000000000002','Synthetic Theatre 2',true);
INSERT INTO public.theatre_sessions (id, session_date, theatre_id, session, surgical_consultant, notes) VALUES
 ('80000000-0000-0000-0000-000000000001','2030-01-07','70000000-0000-0000-0000-000000000001','am','legacy title',NULL),
 ('80000000-0000-0000-0000-000000000002','2030-01-07','70000000-0000-0000-0000-000000000001','pm',NULL,'coordinator note'),
 ('80000000-0000-0000-0000-000000000003','2030-01-07','70000000-0000-0000-0000-000000000002','am',NULL,NULL),
 ('80000000-0000-0000-0000-000000000004','2030-01-08','70000000-0000-0000-0000-000000000001','am',NULL,NULL),
 ('80000000-0000-0000-0000-000000000005','2031-06-02','70000000-0000-0000-0000-000000000001','am',NULL,NULL);
