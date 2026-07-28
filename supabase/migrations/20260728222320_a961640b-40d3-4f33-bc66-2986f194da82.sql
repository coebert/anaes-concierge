INSERT INTO public.duty_type_mappings (duty_type, pattern, match_type, priority, active, notes)
VALUES
  ('teaching', 'tutorial', 'substring', 50, true, 'Consultant/SAS-delivered tutorials from CLWRota'),
  ('teaching', 'tutorials', 'substring', 50, true, 'Consultant/SAS-delivered tutorials from CLWRota'),
  ('teaching', 'lecture', 'substring', 50, true, 'Lectures delivered by senior staff from CLWRota'),
  ('teaching', 'departmental teaching', 'substring', 60, true, 'Departmental teaching sessions')
ON CONFLICT DO NOTHING;