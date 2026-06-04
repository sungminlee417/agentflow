-- "Rising" trend kind + saturation warnings.
--
-- We were treating trends as a single bucket — "trend" meaning
-- something currently visible in the niche. But there are really two
-- temporal signals that matter:
--   • RISING — engagement velocity is accelerating but the trend
--     hasn't peaked. This is "be early to the curve."
--   • SATURATED — too many similar videos with declining returns.
--     This is the warning sign to avoid, or to do with a strong twist.
--
-- "rising" piggybacks on the existing kind column (TEXT — no enum
-- constraint to migrate). The agent now emits it for ideas riding an
-- accelerating signal. TTL is short — same as trend (7 days) — because
-- these die fast.
--
-- saturation_warning is a free-text note the agent can attach to ANY
-- idea (regardless of kind) when it detected oversaturation in the
-- format/topic/hashtag. Surfaces on the card as an amber strip so the
-- user understands why the agent paired the idea with a specific
-- twist or recommendation.

ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS saturation_warning TEXT;

NOTIFY pgrst, 'reload schema';
