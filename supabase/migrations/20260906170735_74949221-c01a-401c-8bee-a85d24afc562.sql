ALTER TABLE public.icu_sync_state
  ADD COLUMN IF NOT EXISTS future_cursor_start date;

UPDATE public.icu_sync_state
  SET days_ahead = GREATEST(days_ahead, 180),
      future_cursor_start = COALESCE(future_cursor_start, CURRENT_DATE),
      updated_at = now()
  WHERE id = 1;