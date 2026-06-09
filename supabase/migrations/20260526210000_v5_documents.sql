CREATE TABLE IF NOT EXISTS documents (
  id                 BIGSERIAL PRIMARY KEY,
  telegram_file_id   TEXT,
  telegram_unique_id TEXT,
  source             TEXT NOT NULL CHECK (source IN ('telegram_photo','telegram_document','laptop_inbox')),
  caption            TEXT,
  mime_type          TEXT,
  bytes              INT,
  doc_type           TEXT,
  confidence         NUMERIC(4,3),
  summary            TEXT,
  extracted_data     JSONB DEFAULT '{}'::jsonb,
  action_taken       TEXT,
  action_ref         TEXT,
  raw_response       TEXT,
  processed_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_docs_type_date ON documents(doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_action ON documents(action_taken);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
