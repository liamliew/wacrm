-- ============================================================
-- 060_ai_handoff_settings.sql — Handoff hours + customer message
--
-- When the AI hands a conversation to a human, the account can now tell
-- the customer what is happening:
--
--   handoff_timezone         IANA zone the weekly hours are read in.
--   handoff_hours            Weekly opening hours as jsonb, e.g.
--                              {"mon":{"open":true,"start":"09:00","end":"18:00"}, ...}
--                            NULL = not configured (the open message is used).
--   handoff_message_enabled  Master switch for the message.
--   handoff_open_message     Sent when the AI hands off while the team is open.
--   handoff_closed_message   Sent when it hands off while the team is closed.
--   handoff_cap_message      Sent when the bot stops at its reply limit.
--
-- Messages may use {{next_open_day}}, {{next_open_time}} and {{hours_today}}.
--
-- The columns live on ai_configs (UNIQUE per account), so they inherit its
-- row level security unchanged: any member can read, admin+ can write.
-- ai_configs.handoff_agent_id (033) stays where it is.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  ADD COLUMN IF NOT EXISTS handoff_hours jsonb,
  ADD COLUMN IF NOT EXISTS handoff_message_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS handoff_open_message text,
  ADD COLUMN IF NOT EXISTS handoff_closed_message text,
  ADD COLUMN IF NOT EXISTS handoff_cap_message text;

-- Light shape checks; the app validates properly (valid zone, HH:MM times,
-- end after start) before writing. Drop-then-add keeps this re-runnable.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_handoff_timezone_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_handoff_timezone_check
  CHECK (length(handoff_timezone) BETWEEN 1 AND 64);

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_handoff_hours_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_handoff_hours_check
  CHECK (handoff_hours IS NULL OR jsonb_typeof(handoff_hours) = 'object');

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_handoff_messages_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_handoff_messages_check
  CHECK (
    (handoff_open_message   IS NULL OR length(handoff_open_message)   <= 1000) AND
    (handoff_closed_message IS NULL OR length(handoff_closed_message) <= 1000) AND
    (handoff_cap_message    IS NULL OR length(handoff_cap_message)    <= 1000)
  );
