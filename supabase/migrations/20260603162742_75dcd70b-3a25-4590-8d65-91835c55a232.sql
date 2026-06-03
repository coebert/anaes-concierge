-- One-off cleanup: delete CLWRota-sourced theatre rows whose underlying
-- label is a known non-working / cover-pool marker (Off, Off Day,
-- Available, Spare, TBC, Unallocated, etc.). These were created by older
-- sync runs before the non-working classifier matured and the sync skip
-- path only ignored them going forward — it never removed the historical
-- rows, leaving thousands of bogus duty_type='theatre' rows with no
-- theatre_session_id that polluted trainee unmatched-row metrics.
-- Locally-modified rows are preserved so coordinator hand edits survive.
DELETE FROM public.rota_assignments
WHERE source = 'clwrota'
  AND duty_type = 'theatre'
  AND theatre_session_id IS NULL
  AND locally_modified = false
  AND notes ~* '^Surgeon:\s*(off|off day|day off|not working|available(/clinical)?|spare|free|tbc|tba|unallocated|nil)\s*$';
