-- Closed-loop performance review for video ideas.
--
-- Once the user marks an idea as 'done' and links the actual posted
-- TikTok video, we can pull its stats, compare to their baseline, and
-- produce a verdict + post-mortem. Future idea generation uses these
-- post-mortems as evidence so the system learns from outcomes.
--
-- Columns:
--   • posted_video_id, posted_video_url, posted_at — the link itself
--   • performance_verdict — categorical ('hit' | 'on_track' |
--     'underperformed' | 'too_early')
--   • performance_score — engagement rate (likes / views) at last review
--   • performance_review — markdown post-mortem (2-3 sentence verdict
--     + 3-5 bullet learnings)
--   • performance_stats — JSONB snapshot of {views, likes, comments,
--     shares, baseline_median, ratio}
--   • last_reviewed_at — when worker last ran the review
--   • next_review_at — when worker should next run; NULL = no more
--     reviews scheduled (e.g. settled at 7d).

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS posted_video_id     TEXT,
  ADD COLUMN IF NOT EXISTS posted_video_url    TEXT,
  ADD COLUMN IF NOT EXISTS posted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS performance_verdict TEXT,
  ADD COLUMN IF NOT EXISTS performance_score   NUMERIC,
  ADD COLUMN IF NOT EXISTS performance_review  TEXT,
  ADD COLUMN IF NOT EXISTS performance_stats   JSONB,
  ADD COLUMN IF NOT EXISTS last_reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_review_at      TIMESTAMPTZ;

-- Worker polls on (next_review_at < now) — partial index keeps the
-- scan tight even as the table grows.
CREATE INDEX IF NOT EXISTS video_ideas_review_due_idx
  ON video_ideas (next_review_at)
  WHERE next_review_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
