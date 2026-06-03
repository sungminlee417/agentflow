-- Virality-oriented fields on video_ideas.
--
-- The original schema captured "what to record" (script, hashtags,
-- visual notes). These columns capture "what gives it a better shot
-- at going viral":
--
--   • optimal_post_window — human-readable day-of-week + hour range
--     ("Tue-Thu 7-9pm local") derived from when this creator's top
--     performers were posted + niche peak times. Closest thing we
--     can get to audience-by-hour without TikTok Studio.
--   • suggested_duration — recommended length window ("18-25s"). Short
--     videos tend to have higher completion rate; some formats need
--     more room. The agent picks per idea.
--   • thumbnail_concept — what the first frame should look like.
--     TikTok's For You feed shows the first frame as the cover —
--     getting that right matters as much as the hook.
--   • engagement_hook — a specific element designed to drive comments
--     (e.g. "ask viewers to pick sound A or B"). Distinct from the
--     opening hook (which is about stopping the scroll).
--   • trending_sound — if applicable, the specific TikTok sound the
--     idea should use, with creator/song info if known.
--
-- All TEXT and nullable — partial outputs from the agent still land
-- cleanly.

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS optimal_post_window TEXT,
  ADD COLUMN IF NOT EXISTS suggested_duration  TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_concept   TEXT,
  ADD COLUMN IF NOT EXISTS engagement_hook     TEXT,
  ADD COLUMN IF NOT EXISTS trending_sound      TEXT;

NOTIFY pgrst, 'reload schema';
