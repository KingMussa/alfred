-- v8 — let cost_log.service hold full model IDs (2026-06-09)
-- Applied live via Supabase MCP; kept here for the record.
--
-- The original cost_log.service CHECK only allowed coarse categories
-- (gemini/claude/twilio/telegram/other), which silently rejected full model
-- IDs like 'claude-opus-4-8' — so logCost inserts failed. We store model IDs
-- now for per-model spend in /cost, so drop the restriction.
ALTER TABLE cost_log DROP CONSTRAINT IF EXISTS cost_log_service_check;

-- (cost_log already existed from v3; new writer is _shared/cost.ts logCost().)
-- Daily cap pref seeded separately: preferences.daily_cost_cap = {"usd":5}
