-- v8 — income by stream + tax-reserve guardrail (2026-06-09)
-- Applied live via Supabase MCP; kept here for the record.

CREATE TABLE IF NOT EXISTS income (
  id           BIGSERIAL PRIMARY KEY,
  stream       TEXT NOT NULL,                  -- union | solar | creative | spouse | other
  gross        NUMERIC(12,2) NOT NULL,
  net          NUMERIC(12,2),
  is_1099      BOOLEAN DEFAULT false,          -- untaxed income that needs a reserve
  tax_reserved NUMERIC(12,2) DEFAULT 0,
  received_at  DATE DEFAULT (now() AT TIME ZONE 'America/Los_Angeles'),
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_income_received ON income(received_at DESC);
ALTER TABLE income ENABLE ROW LEVEL SECURITY;

INSERT INTO preferences (key, value)
SELECT 'tax_reserve_pct', '{"pct":30}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE key = 'tax_reserve_pct');
