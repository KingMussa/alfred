CREATE TABLE IF NOT EXISTS review_queue (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  subtitle     TEXT,
  size_mb      REAL    DEFAULT 0,
  msg_count    INT     DEFAULT 0,
  days_stale   INT     DEFAULT 0,
  is_protected BOOLEAN DEFAULT FALSE,
  protection_reason TEXT,
  metadata     JSONB   DEFAULT '{}',
  priority     INT     DEFAULT 0,
  status       TEXT    DEFAULT 'pending',
  decided_at   TIMESTAMPTZ,
  batch_num    INT     DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rq_status   ON review_queue(status);
CREATE INDEX IF NOT EXISTS idx_rq_priority ON review_queue(priority DESC);

CREATE TABLE IF NOT EXISTS review_session (
  id            INT PRIMARY KEY DEFAULT 1,
  current_batch JSONB  DEFAULT '[]',
  batch_index   INT    DEFAULT 0,
  mode          TEXT   DEFAULT 'all',
  last_active   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO review_session(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
