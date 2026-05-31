-- Social brief automations.
--
-- Adds:
--   • automations.schedule — how often this automation should run on
--     its own ('manual' | 'daily' | 'weekly'). The worker checks
--     last_run_at against this to decide whether to fire.
--   • automation_runs.report_markdown — for automations that produce
--     a long-form brief (rather than a PR), we store the markdown
--     here so the dashboard can render it.
--
-- For the existing github_issue_to_pr automations, schedule defaults
-- to 'manual' and the existing per-issue dedup logic continues to
-- govern when to run. The worker's social dispatcher uses schedule.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS schedule TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS report_markdown TEXT;

-- issue_number is GitHub-specific; social brief runs don't have one.
-- Make it nullable so the column can be omitted for non-issue runs.
ALTER TABLE automation_runs
  ALTER COLUMN issue_number DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
