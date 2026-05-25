-- Enable scheduling and HTTP extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Track which emails have been seen so we don't re-alert
CREATE TABLE IF NOT EXISTS processed_emails (
  message_id       TEXT PRIMARY KEY,
  subject          TEXT,
  sender           TEXT,
  importance_score INTEGER,
  notified         BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Prevent duplicate calendar reminders per event
CREATE TABLE IF NOT EXISTS calendar_reminders_sent (
  event_id      TEXT NOT NULL,
  reminder_type TEXT NOT NULL, -- '1h' or '15m'
  sent_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event_id, reminder_type)
);

-- Full log of every SMS sent
CREATE TABLE IF NOT EXISTS sms_log (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL,
  type    TEXT NOT NULL, -- 'morning_briefing' | 'email_alert' | 'calendar_reminder'
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-purge processed emails older than 7 days to keep the table lean
CREATE OR REPLACE FUNCTION purge_old_emails() RETURNS void
LANGUAGE SQL AS $$
  DELETE FROM processed_emails WHERE created_at < NOW() - INTERVAL '7 days';
$$;

SELECT cron.schedule('purge-old-emails', '0 3 * * *', 'SELECT purge_old_emails()');
