-- User edit log for video_ideas content fields. Feeds the learning loop:
-- the unified generator reads recent edits per-account and adapts its
-- voice for the next batch ("creator typically rewrites X-style hooks
-- into Y-style — match that").
--
-- We log a row only when a content field's value substantively changed
-- (the PATCH route applies a whitespace-trim + min-length-diff check
-- before inserting here). Whitespace tweaks and one-off polish accept
-- clicks shouldn't pollute the signal.
--
-- field is a free-text key (title / hook / script / post_title / etc.).
-- original_value and edited_value are the actual content snapshots —
-- size-bounded by the application layer (max 8KB each in practice; we
-- don't enforce in DB so the column can hold a long script edit too).
-- integration_id is the idea's PRIMARY target, denormalised so the
-- learning loop can group edits per account in one round-trip.

CREATE TABLE IF NOT EXISTS video_idea_edits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idea_id         UUID NOT NULL REFERENCES video_ideas(id) ON DELETE CASCADE,
  integration_id  UUID REFERENCES integrations(id) ON DELETE SET NULL,
  field           TEXT NOT NULL,
  original_value  TEXT,
  edited_value    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: the unified prompt builder reads "recent N edits per
-- account" — so (user_id, integration_id, created_at DESC) is the
-- shape we index.
CREATE INDEX IF NOT EXISTS video_idea_edits_acct_idx
  ON video_idea_edits (user_id, integration_id, created_at DESC);

ALTER TABLE video_idea_edits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_idea_edits' AND policyname='video_idea_edits_owner'
  ) THEN
    CREATE POLICY video_idea_edits_owner ON video_idea_edits
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
