-- Per-account creator preferences.
--
-- Free-text constraints/preferences the creator wants the agent to
-- respect when generating + evaluating ideas. Examples:
--   • "Don't suggest gym filming — not comfortable there yet"
--   • "Prefer outdoor / golden-hour lighting"
--   • "No talking-head — keep my face out of frame"
--   • "Lean shorter (<25s); my longer videos underperform"
--
-- Single TEXT field for maximum flexibility — the agent reads it
-- verbatim and incorporates it. Lives on video_ideas_settings since
-- that's already per (user, integration) keyed.

ALTER TABLE video_ideas_settings
  ADD COLUMN IF NOT EXISTS preferences TEXT;

NOTIFY pgrst, 'reload schema';
