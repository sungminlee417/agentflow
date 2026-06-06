-- Per-platform caption packaging on each video idea.
--
-- The shoot itself (script, hook, visual_notes, cta, virality fields)
-- is shared — one recording, three uploads. But the caption packaging
-- differs by platform: TikTok wants a short punchy caption, YouTube
-- Shorts wants a distinct title + longer description, Instagram Reels
-- wants a storytelling caption. Hashtag selection also differs (YT
-- treats #tags as discovery; IG limits inline tags; TikTok uses 5-7).
--
-- Shape stored in the platforms JSON:
--   {
--     "tiktok":    { "caption": string, "hashtags": [string, ...] },
--     "youtube":   { "title": string, "description": string, "hashtags": [string, ...] },
--     "instagram": { "caption": string, "hashtags": [string, ...] }
--   }
-- Any subset of keys is valid — only platforms the user has connected
-- get a variant. The legacy post_title / description / hashtags
-- columns are kept as the "generic" / TikTok-style fallback for
-- backwards compat with existing ideas.

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS platforms JSONB;

NOTIFY pgrst, 'reload schema';
