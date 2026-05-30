-- Widen messages.role to allow tool-call turns.
--
-- The initial chat migration restricted role to 'user' | 'assistant',
-- which fit the pure-text chat. Now that the agent can call tools,
-- the AI SDK also produces 'tool' role messages (tool results) and
-- 'system' role messages (system prompts persisted into history).
--
-- content_json continues to hold the AI-SDK CoreMessage content shape
-- verbatim — no shape change at the column level.

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_role_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_role_check
  CHECK (role IN ('user', 'assistant', 'tool', 'system'));

NOTIFY pgrst, 'reload schema';
