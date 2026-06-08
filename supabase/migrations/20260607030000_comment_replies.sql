-- Inbox: comment-reply drafts queue.
--
-- The Inbox surface is where the creator handles incoming engagement
-- across all their connected platforms in one place. For each new
-- comment on one of the creator's videos:
--   1. We fetch the comment via the platform API (manual pull for
--      v1; webhook-driven later when each platform supports it).
--   2. The AI generates a reply draft using the per-account voice
--      context (top performers + recent reviews + edits — same
--      primitives the video-ideas polish endpoint uses).
--   3. The creator reviews the draft in the Inbox UI: edit, send,
--      or dismiss. Sending posts via the platform API.
--
-- Why draft-and-approve instead of full auto-send: platforms
-- aggressively flag rapid-fire automated replies. A human-in-the-loop
-- queue is safer for ToS, faster to build (no anti-abuse heuristics
-- needed on day one), and the "full auto" mode can become a per-rule
-- toggle later once the drafts are reliably good.

CREATE TABLE IF NOT EXISTS comment_replies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration_id      UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL CHECK (platform IN ('tiktok', 'youtube', 'instagram')),

  -- The original comment we're replying to.
  source_comment_id   TEXT NOT NULL,
  source_author       TEXT,
  source_text         TEXT,
  source_video_id     TEXT,
  source_video_url    TEXT,
  source_video_title  TEXT,
  source_posted_at    TIMESTAMPTZ,

  -- AI draft + lifecycle.
  draft_text          TEXT,
  draft_model         TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'sent', 'dismissed', 'failed')),
  /** The platform-side reply id once sent; null otherwise. */
  sent_reply_id       TEXT,
  send_error          TEXT,
  sent_at             TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dedupe key: same source comment can only appear once per account.
  UNIQUE (integration_id, source_comment_id)
);

CREATE INDEX IF NOT EXISTS comment_replies_user_status_idx
  ON comment_replies (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS comment_replies_acct_idx
  ON comment_replies (integration_id, status, created_at DESC);

ALTER TABLE comment_replies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='comment_replies' AND policyname='comment_replies_owner'
  ) THEN
    CREATE POLICY comment_replies_owner ON comment_replies
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Tracks "when did we last pull comments for this integration?" so the
-- pull route can skip the bulk of already-seen comments. We could put
-- this on the integrations table but a separate small table keeps the
-- main one clean (and we may want per-channel state here later).
CREATE TABLE IF NOT EXISTS inbox_pull_state (
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  last_pulled_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (integration_id)
);

ALTER TABLE inbox_pull_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='inbox_pull_state' AND policyname='inbox_pull_state_owner'
  ) THEN
    CREATE POLICY inbox_pull_state_owner ON inbox_pull_state
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
