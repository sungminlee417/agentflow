-- Per-turn job tracker for the chat agent.
--
-- The chat route already persists user/assistant/tool messages into
-- the `messages` table on `onFinish`. Two problems with that as a
-- standalone primitive:
--   1. While the agent is generating, there's no row anywhere — so
--      if the user navigates away from /chat and comes back before
--      `onFinish` fires, the page has no way to know "the agent is
--      still thinking; just wait for the assistant message to land."
--   2. There's no place to record a per-turn failure (the messages
--      table is content-shaped, not job-shaped).
--
-- This table fills both gaps. One row per user-turn → assistant-
-- response cycle. Lifecycle:
--   running  → inserted when the chat route starts streamText
--   done     → set in onFinish (assistant + tool messages just got
--              persisted to `messages`)
--   failed   → set on stream error or model failure
--
-- The client subscribes to this AND to `messages` via Supabase
-- realtime, so navigating back to /chat shows "still generating…"
-- while a running row exists, and the new assistant message appears
-- the moment it lands.

CREATE TABLE IF NOT EXISTS chat_turn_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'done', 'failed')),
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

-- Client polls / subscribes per conversation, so the (conversation_id,
-- status) shape is the hot path.
CREATE INDEX IF NOT EXISTS chat_turn_jobs_conversation_idx
  ON chat_turn_jobs (conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS chat_turn_jobs_running_idx
  ON chat_turn_jobs (status, updated_at)
  WHERE status = 'running';

ALTER TABLE chat_turn_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='chat_turn_jobs'
      AND policyname='chat_turn_jobs_owner'
  ) THEN
    CREATE POLICY chat_turn_jobs_owner ON chat_turn_jobs
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Expose to Supabase realtime so the client can listen for status
-- transitions (running → done/failed) without polling.
ALTER PUBLICATION supabase_realtime ADD TABLE chat_turn_jobs;

NOTIFY pgrst, 'reload schema';
