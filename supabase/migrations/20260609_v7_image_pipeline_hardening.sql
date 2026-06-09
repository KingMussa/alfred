-- v7 — image-pipeline hardening (2026-06-09)
-- Applied live via Supabase MCP; kept here for the record.

-- Idempotency: one row per processed Telegram update_id; retries hit the PK and skip.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  seen_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE processed_updates ENABLE ROW LEVEL SECURITY;

-- Durable archive of the actual captured image/PDF (Supabase Storage path).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_path TEXT;

-- Private bucket for captured documents (service-role access bypasses RLS).
INSERT INTO storage.buckets (id, name, public)
VALUES ('alfred-docs', 'alfred-docs', false)
ON CONFLICT (id) DO NOTHING;
