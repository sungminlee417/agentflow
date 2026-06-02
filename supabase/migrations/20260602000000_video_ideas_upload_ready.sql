-- Upload-ready content for video ideas.
--
-- Each idea now carries everything the creator needs to actually
-- record + post: a full beat-by-beat script, suggested post title +
-- caption/description, a hashtag list, an explicit CTA, and short
-- visual/production notes. This replaces the previous "just a title
-- and a hook" shape — that was a teaser, this is the deliverable.
--
-- We store hashtags as TEXT[] so the UI can render copyable chips
-- without splitting strings client-side. Everything else is TEXT and
-- nullable so partial outputs from the agent still land cleanly.

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS script TEXT,
  ADD COLUMN IF NOT EXISTS post_title TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS hashtags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS visual_notes TEXT,
  ADD COLUMN IF NOT EXISTS cta TEXT;

NOTIFY pgrst, 'reload schema';
