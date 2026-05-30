-- Chat: conversations and messages.
--
-- This is the primary user surface — a single agent chat with access
-- to whichever tools the user has connected (YouTube, TikTok, IG, ...)
-- plus their own Anthropic API key from user_api_keys.
--
-- Messages store Anthropic's content-block JSON shape verbatim in
-- content_json so we don't lose fidelity from the API response.
-- Content blocks include:
--   • text          — { "type": "text", "text": "..." }
--   • tool_use      — { "type": "tool_use", "id", "name", "input" }
--   • tool_result   — { "type": "tool_result", "tool_use_id", "content" }
-- A single message row can contain multiple blocks in one array.
--
-- The `role` is the message author: 'user', 'assistant'. Tool results
-- come back as 'user' messages with tool_result content blocks (per
-- the Anthropic API).

-- conversations -----------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT,  -- agent-generated summary; nullable until first turn
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations'
      AND policyname='conversations_owner'
  ) THEN
    CREATE POLICY conversations_owner ON conversations
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- messages ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json    JSONB NOT NULL,  -- Anthropic content blocks
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages'
      AND policyname='messages_owner_read'
  ) THEN
    CREATE POLICY messages_owner_read ON messages
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = messages.conversation_id AND c.user_id = auth.uid()
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages'
      AND policyname='messages_owner_insert'
  ) THEN
    CREATE POLICY messages_owner_insert ON messages
      FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = messages.conversation_id AND c.user_id = auth.uid()
      ));
  END IF;
END $$;

-- Realtime: stream new messages into the chat UI as the agent
-- produces tool_use / tool_result / text blocks.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
