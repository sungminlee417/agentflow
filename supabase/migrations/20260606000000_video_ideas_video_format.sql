-- video_format column on video_ideas.
--
-- Only meaningful for YouTube ideas, since YT is the one platform
-- where the same channel can post both Shorts (≤60s) and long-form
-- (3-15+ min) and the two formats have completely different algos,
-- audience expectations, and optimisation rules. TikTok and Instagram
-- Reels are short-only platforms, so this stays NULL for them.
--
-- Values: 'short' | 'long' | NULL.
-- The agent now decides per-idea based on the channel's actual upload
-- mix (read at refresh time via youtube_list_my_videos durations).

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS video_format TEXT;

NOTIFY pgrst, 'reload schema';
