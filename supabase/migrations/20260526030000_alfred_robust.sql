-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ Alfred v3 — the robust butler                                              ║
-- ║                                                                            ║
-- ║ Adds: quick capture, financial intel, habits, journal, conversation       ║
-- ║ memory, audit log, health checks, cost monitoring, bills + reminders.      ║
-- ╚════════════════════════════════════════════════════════════════════════════╝

-- ── 1. QUICK CAPTURE: notes, ideas, todos ────────────────────────────────────
-- Anything Dave throws at Alfred via Telegram (/note, /idea, /todo) lands here.
CREATE TABLE IF NOT EXISTS captures (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN
              ('note','idea','todo','jobsite','quote','win','question')),
  body       TEXT NOT NULL,
  tags       TEXT[] DEFAULT ARRAY[]::TEXT[],
  done       BOOLEAN DEFAULT FALSE,        -- relevant for todos
  metadata   JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_captures_kind_created ON captures(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_done         ON captures(done) WHERE kind = 'todo';

-- ── 2. EXPENSES — spending log + spending-limit guard ────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id         BIGSERIAL PRIMARY KEY,
  amount     NUMERIC(10,2) NOT NULL,
  category   TEXT NOT NULL CHECK (category IN
              ('atm','dining','casino','amazon','gas','groceries',
               'apple_cash','subscription','gear','other')),
  note       TEXT,
  spent_at   DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_cat_date ON expenses(category, spent_at DESC);

-- Spending limits Dave set in finances_dave.md — checked by evening digest.
CREATE TABLE IF NOT EXISTS spending_limits (
  category   TEXT PRIMARY KEY,
  monthly_cap NUMERIC(10,2) NOT NULL,
  biweekly_cap NUMERIC(10,2)
);
INSERT INTO spending_limits (category, monthly_cap, biweekly_cap) VALUES
  ('atm',         300,  150),
  ('dining',      250,  125),
  ('casino',      100,   50),
  ('amazon',      100,   50),
  ('apple_cash',  100,   50),
  ('gas',         200,  100),
  ('groceries',   300,  150)
ON CONFLICT (category) DO NOTHING;

-- ── 3. BILLS — recurring obligations + due-date reminders ────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  due_day         INT NOT NULL CHECK (due_day BETWEEN 1 AND 31),  -- day of month
  paid_from       TEXT,                                            -- account name
  priority        INT DEFAULT 5,           -- 1 = must-pay (IRS, rent)
  active          BOOLEAN DEFAULT TRUE,
  reminder_days   INT[] DEFAULT ARRAY[3,1,0],   -- text Dave 3 days out, 1 day, day-of
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bills_active_due ON bills(active, due_day);

-- Track which bill reminders have fired this month so we don't double-text.
CREATE TABLE IF NOT EXISTS bill_reminders_sent (
  bill_id    BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  due_date   DATE   NOT NULL,
  days_out   INT    NOT NULL,
  sent_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (bill_id, due_date, days_out)
);

-- ── 4. IRS TRACKER — the most important table in this whole system ──────────
CREATE TABLE IF NOT EXISTS irs_progress (
  id              SERIAL PRIMARY KEY,
  balance         NUMERIC(10,2) NOT NULL,
  payment_applied NUMERIC(10,2),
  recorded_on     DATE DEFAULT CURRENT_DATE,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Seed current balance from finances_dave.md (after $7k lump applied = $25k)
INSERT INTO irs_progress (balance, payment_applied, note)
SELECT 25000.00, 7000.00, 'Initial seed — May 2026 after $7k lump sum'
WHERE NOT EXISTS (SELECT 1 FROM irs_progress);

-- ── 5. HABITS — what Dave wants to do every day, with streaks ───────────────
CREATE TABLE IF NOT EXISTS habits (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  emoji      TEXT,
  target     TEXT,                  -- human-readable target ("under $75")
  cadence    TEXT DEFAULT 'daily',  -- daily | weekday | weekly
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id        BIGSERIAL PRIMARY KEY,
  habit_id  BIGINT REFERENCES habits(id) ON DELETE CASCADE,
  log_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  done      BOOLEAN DEFAULT TRUE,
  note      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON habit_logs(log_date DESC);

-- ── 6. JOURNAL — daily reflection prompted by evening digest ────────────────
CREATE TABLE IF NOT EXISTS journal (
  id         BIGSERIAL PRIMARY KEY,
  entry_date DATE UNIQUE DEFAULT CURRENT_DATE,
  body       TEXT NOT NULL,
  mood       INT CHECK (mood BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 7. CONVERSATION MEMORY — so Alfred remembers what you talked about ──────
CREATE TABLE IF NOT EXISTS conversation_memory (
  id         BIGSERIAL PRIMARY KEY,
  role       TEXT CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  tokens     INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_recent ON conversation_memory(created_at DESC);

-- Auto-purge anything older than 14 days — keep memory rolling but bounded
CREATE OR REPLACE FUNCTION purge_old_conversation() RETURNS void
LANGUAGE SQL AS $$
  DELETE FROM conversation_memory WHERE created_at < NOW() - INTERVAL '14 days';
$$;

-- ── 8. AUDIT LOG — every action Alfred takes is recorded ────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  function_name TEXT NOT NULL,
  action     TEXT NOT NULL,
  status     TEXT DEFAULT 'ok' CHECK (status IN ('ok','warn','error')),
  details    JSONB DEFAULT '{}'::jsonb,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_fn_time ON audit_log(function_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_status  ON audit_log(status) WHERE status != 'ok';

-- ── 9. HEALTH CHECKS — dead-man switch ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_checks (
  id         BIGSERIAL PRIMARY KEY,
  function_name TEXT NOT NULL,
  ok         BOOLEAN NOT NULL,
  detail     TEXT,
  checked_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_recent ON health_checks(function_name, checked_at DESC);

-- ── 10. COST LOG — track Gemini/Claude/Twilio spend so it never runs away ──
CREATE TABLE IF NOT EXISTS cost_log (
  id          BIGSERIAL PRIMARY KEY,
  service     TEXT NOT NULL CHECK (service IN ('gemini','claude','twilio','telegram','other')),
  units       INT,                      -- tokens for AI, segments for SMS
  cost_usd    NUMERIC(10,4) DEFAULT 0,
  function_name TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cost_recent ON cost_log(created_at DESC);

-- ── 11. WEATHER CACHE — avoid hammering open-meteo ──────────────────────────
CREATE TABLE IF NOT EXISTS weather_cache (
  cache_date DATE PRIMARY KEY,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 12. CONTENT IDEA INBOX — for @dadailydougie growth ──────────────────────
-- Captures of kind='idea' get a richer side-table for content-specific fields
CREATE TABLE IF NOT EXISTS content_ideas (
  id         BIGSERIAL PRIMARY KEY,
  hook       TEXT NOT NULL,
  platform   TEXT CHECK (platform IN ('instagram','tiktok','youtube','any')) DEFAULT 'any',
  format     TEXT CHECK (format IN ('reel','short','carousel','post','story','any')) DEFAULT 'any',
  status     TEXT CHECK (status IN ('idea','scripted','filmed','posted','dead')) DEFAULT 'idea',
  posted_url TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  posted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_content_status ON content_ideas(status, created_at DESC);

-- ── 13. QUIET HOURS — Dave can tell Alfred to shut up at night ──────────────
CREATE TABLE IF NOT EXISTS preferences (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO preferences (key, value) VALUES
  ('quiet_hours',  '{"start":"22:00","end":"06:30","tz":"America/New_York"}'::jsonb),
  ('persona',      '"alfred"'::jsonb),
  ('home_zip',     '"10001"'::jsonb),
  ('jobsite_address','"NYC"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 14. CRON SCHEDULES — new periodic jobs ──────────────────────────────────
-- (cron.schedule is idempotent on identical job names — safe to re-run.)

-- Evening digest — 9 PM ET = 01:00 UTC (next day) during EDT
SELECT cron.schedule(
  'evening-digest',
  '0 1 * * *',
  $$SELECT net.http_post(
    url := 'https://rwhfueaclqcunnoraaix.supabase.co/functions/v1/evening-digest',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '|| (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='anon_key' LIMIT 1)),
    body := '{}'::jsonb
  );$$
);

-- Bill reminder — 8 AM ET = 12:00 UTC during EDT
SELECT cron.schedule(
  'bill-reminder',
  '0 12 * * *',
  $$SELECT net.http_post(
    url := 'https://rwhfueaclqcunnoraaix.supabase.co/functions/v1/bill-reminder',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '|| (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='anon_key' LIMIT 1)),
    body := '{}'::jsonb
  );$$
);

-- Health check — every hour on the :07 to avoid colliding with other crons
SELECT cron.schedule(
  'health-check',
  '7 * * * *',
  $$SELECT net.http_post(
    url := 'https://rwhfueaclqcunnoraaix.supabase.co/functions/v1/health-check',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '|| (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='anon_key' LIMIT 1)),
    body := '{}'::jsonb
  );$$
);

-- Weekly review — Sunday 7 PM ET = 23:00 UTC during EDT
SELECT cron.schedule(
  'weekly-review',
  '0 23 * * 0',
  $$SELECT net.http_post(
    url := 'https://rwhfueaclqcunnoraaix.supabase.co/functions/v1/weekly-review',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '|| (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='anon_key' LIMIT 1)),
    body := '{}'::jsonb
  );$$
);

-- Purge old conversation memory — daily at 03:30 UTC
SELECT cron.schedule(
  'purge-conversation',
  '30 3 * * *',
  'SELECT purge_old_conversation()'
);

-- Purge old audit logs (>90 days) and health checks (>30 days)
CREATE OR REPLACE FUNCTION purge_old_telemetry() RETURNS void
LANGUAGE SQL AS $$
  DELETE FROM audit_log     WHERE created_at < NOW() - INTERVAL '90 days';
  DELETE FROM health_checks WHERE checked_at < NOW() - INTERVAL '30 days';
  DELETE FROM cost_log      WHERE created_at < NOW() - INTERVAL '365 days';
$$;
SELECT cron.schedule('purge-telemetry', '45 3 * * 0', 'SELECT purge_old_telemetry()');
