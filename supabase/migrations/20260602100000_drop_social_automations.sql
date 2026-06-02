-- Drop scheduled social-brief + social-scripts automations.
--
-- The Social Media Manager concept is being retired in favor of two
-- canonical surfaces:
--   • Video Ideas — the live, refreshable list of upload-ready
--     content ideas (replaces social_scripts_*)
--   • Chat — for one-off briefs and analysis (replaces social_brief_*)
--
-- This migration removes any existing automations + their run history
-- whose type starts with 'social_'. github_issue_to_pr automations
-- and their runs are unaffected.

DELETE FROM automation_runs
WHERE automation_id IN (
  SELECT id FROM automations WHERE type LIKE 'social_%'
);

DELETE FROM automations
WHERE type LIKE 'social_%';

NOTIFY pgrst, 'reload schema';
