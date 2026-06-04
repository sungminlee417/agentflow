-- Manual priority ordering for the "Working on" queue.
--
-- Once the user commits to working on a set of ideas, the order
-- matters — they shoot in sequence, often blocking on which one comes
-- next. Add a numeric priority so the Working on tab can be drag-to-
-- reordered and the order persists across sessions.
--
-- Lower priority = closer to the top of the queue (matches common
-- mental model "this is my #1"). We use INTEGER, not FLOAT, with
-- multi-thousand gaps between consecutive items so reordering can
-- insert between two items by averaging their priorities without
-- rebalancing.
--
-- New ideas default to priority 0 and only get a real value when
-- moved into the Working on queue (priority is assigned at that
-- moment based on current max). Posted/dismissed ideas keep their
-- priority for history but it doesn't drive any UI.

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

-- Partial index on the only state where priority drives ordering.
CREATE INDEX IF NOT EXISTS video_ideas_scheduled_priority_idx
  ON video_ideas (user_id, integration_id, priority, created_at)
  WHERE status = 'scheduled';

NOTIFY pgrst, 'reload schema';
