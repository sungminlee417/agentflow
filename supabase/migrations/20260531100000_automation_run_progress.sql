-- Progress instrumentation for automation runs.
--
-- step_count and last_step let the agent report what it's currently
-- doing (e.g. "Reading issue #42", "Opening PR…") so the dashboard
-- can show live progress instead of just "running".
--
-- Adding automation_runs to the realtime publication so the dashboard
-- can subscribe and reflect updates the instant they're written.

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS step_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_step TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'automation_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE automation_runs;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
