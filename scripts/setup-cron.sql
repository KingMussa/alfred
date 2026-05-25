-- Run this in the Supabase SQL editor AFTER deploying your Edge Functions.
-- Replace the two placeholders below with your real values from the Supabase dashboard.

-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  YOUR_PROJECT_REF  →  Settings > General > Reference ID                 │
-- │  YOUR_ANON_KEY     →  Settings > API > Project API keys > anon/public   │
-- └──────────────────────────────────────────────────────────────────────────┘

-- Morning briefing at 7:00 AM Eastern (= 12:00 PM UTC, adjust if you're in DST)
SELECT cron.schedule(
  'morning-briefing',
  '0 12 * * *',
  $$SELECT net.http_post(
      url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/morning-briefing',
      headers := '{"Authorization": "Bearer YOUR_ANON_KEY", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )$$
);

-- Email check every 30 minutes
SELECT cron.schedule(
  'email-checker',
  '*/30 * * * *',
  $$SELECT net.http_post(
      url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/email-checker',
      headers := '{"Authorization": "Bearer YOUR_ANON_KEY", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )$$
);

-- Calendar reminders every 15 minutes
SELECT cron.schedule(
  'calendar-reminder',
  '*/15 * * * *',
  $$SELECT net.http_post(
      url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/calendar-reminder',
      headers := '{"Authorization": "Bearer YOUR_ANON_KEY", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )$$
);

-- Verify the jobs were created:
SELECT jobname, schedule, active FROM cron.job;
