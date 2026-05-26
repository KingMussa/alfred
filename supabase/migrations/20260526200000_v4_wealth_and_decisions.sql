-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ Alfred v4 — Wealth modeling + investment tracking + decision log         ║
-- ╚════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS assets (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  institution  TEXT,
  account_type TEXT NOT NULL CHECK (account_type IN
                ('checking','savings','mmsa','brokerage','retirement',
                 'crypto','real_estate','vehicle','business','other')),
  balance      NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  active       BOOLEAN DEFAULT TRUE,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_active ON assets(active);
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS liabilities (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  balance       NUMERIC(12,2) NOT NULL,
  interest_rate NUMERIC(5,3),
  min_payment   NUMERIC(10,2),
  payoff_target DATE,
  active        BOOLEAN DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_updated  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_liabilities_active ON liabilities(active);
ALTER TABLE liabilities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS net_worth_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  snapshot_date     DATE UNIQUE NOT NULL DEFAULT CURRENT_DATE,
  assets_total      NUMERIC(12,2) NOT NULL,
  liabilities_total NUMERIC(12,2) NOT NULL,
  net_worth         NUMERIC(12,2) GENERATED ALWAYS AS (assets_total - liabilities_total) STORED,
  delta_vs_prior    NUMERIC(12,2),
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_networth_date ON net_worth_snapshots(snapshot_date DESC);
ALTER TABLE net_worth_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS goal_buckets (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  target_amount  NUMERIC(12,2) NOT NULL,
  current_amount NUMERIC(12,2) DEFAULT 0,
  target_date    DATE,
  priority       INT DEFAULT 5,
  active         BOOLEAN DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE goal_buckets ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS holdings (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL,
  qty         NUMERIC(14,6) NOT NULL,
  cost_basis  NUMERIC(12,2) NOT NULL,
  account     TEXT NOT NULL DEFAULT 'Robinhood',
  asset_class TEXT CHECK (asset_class IN ('stock','etf','crypto','option','mutual_fund')) DEFAULT 'stock',
  notes       TEXT,
  opened_at   TIMESTAMPTZ DEFAULT NOW(),
  closed_at   TIMESTAMPTZ,
  active      BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings(symbol) WHERE active = TRUE;
ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS trades (
  id        BIGSERIAL PRIMARY KEY,
  symbol    TEXT NOT NULL,
  side      TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty       NUMERIC(14,6) NOT NULL,
  price     NUMERIC(12,4) NOT NULL,
  fees      NUMERIC(8,2) DEFAULT 0,
  account   TEXT DEFAULT 'Robinhood',
  notes     TEXT,
  trade_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_date ON trades(symbol, trade_at DESC);
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS decisions (
  id               BIGSERIAL PRIMARY KEY,
  decision         TEXT NOT NULL,
  rationale        TEXT,
  expected_outcome TEXT,
  actual_outcome   TEXT,
  category         TEXT,
  confidence       INT CHECK (confidence BETWEEN 1 AND 10),
  decided_at       TIMESTAMPTZ DEFAULT NOW(),
  review_date      DATE,
  reviewed         BOOLEAN DEFAULT FALSE,
  reviewed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_decisions_review ON decisions(reviewed, review_date) WHERE reviewed = FALSE;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS quote_cache (
  symbol      TEXT PRIMARY KEY,
  price       NUMERIC(12,4),
  change_pct  NUMERIC(8,4),
  payload     JSONB,
  fetched_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE quote_cache ENABLE ROW LEVEL SECURITY;

-- ── Seed Dave's known accounts (idempotent) ─────────────────────────────────
INSERT INTO assets (name, institution, account_type, balance, notes) VALUES
  ('NFCU Checking',     'Navy Federal CU',  'checking',    485.00,  'EveryDay Checking — primary'),
  ('NFCU Savings',      'Navy Federal CU',  'savings',     5620.00, 'Membership Savings'),
  ('NFCU MMSA',         'Navy Federal CU',  'mmsa',        4015.00, 'Money Market Savings'),
  ('BofA Checking',     'Bank of America',  'checking',    397.00,  'SafeBalance — secondary'),
  ('OE Federal',        'OE Federal CU',    'checking',    241.00,  'Union deposits'),
  ('Cap One 360',       'Capital One',      'checking',    24.00,   'Pass-through for auto + insurance'),
  ('Sarasota County Land', 'Family',        'real_estate', 15000.00, 'Lawn Ave, North Port FL 34288 (LOT 15 BLK 1628). Family-owned, confirm Dave''s claim. Est $12-20k.'),
  ('Robinhood',         'Robinhood',        'brokerage',   0.00,    'Set up for Phase 2/3 — currently empty')
ON CONFLICT DO NOTHING;

INSERT INTO liabilities (name, balance, interest_rate, min_payment, payoff_target, notes) VALUES
  ('🔴 IRS Installment Debt', 25000.00, 8.000, 3000.00, '2027-02-01', 'Form 9465 installment. 3 yrs back-filings. Top priority.'),
  ('🚗 Capital One Auto Loan', 15000.00, 7.000, 617.00, '2029-01-01', 'Estimated — confirm via /debt <id> <bal>.')
ON CONFLICT DO NOTHING;

INSERT INTO goal_buckets (name, target_amount, current_amount, target_date, priority, notes) VALUES
  ('🚨 Emergency Fund',    15000.00, 0.00, '2027-08-01', 1, 'Phase 2 — 3mo expenses. HYSA 4.5-5%.'),
  ('🏠 House Down Payment', 40000.00, 0.00, '2029-01-01', 2, 'Reno-area pricing dependent.'),
  ('📈 Roth IRA Seed',      7000.00,  0.00, '2027-12-31', 1, 'Phase 3 — Fidelity/Vanguard, VOO or FXAIX.'),
  ('💼 Triple D Business Fund', 6000.00, 0.00, '2028-06-01', 3, 'LLC working capital.')
ON CONFLICT (name) DO NOTHING;

-- ── Trigger to keep last_updated current ────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_last_updated() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.last_updated = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS assets_touch ON assets;
CREATE TRIGGER assets_touch BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION touch_last_updated();

DROP TRIGGER IF EXISTS liabilities_touch ON liabilities;
CREATE TRIGGER liabilities_touch BEFORE UPDATE ON liabilities
  FOR EACH ROW EXECUTE FUNCTION touch_last_updated();
