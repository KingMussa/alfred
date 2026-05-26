-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ Seed Dave's recurring bills + starter habit set                          ║
-- ║ Source of truth: ~/.claude/projects/-Users-sankore/memory/finances_dave.md ║
-- ╚════════════════════════════════════════════════════════════════════════════╝

-- ── BILLS ───────────────────────────────────────────────────────────────────
INSERT INTO bills (name, amount, due_day, paid_from, priority, reminder_days, notes)
VALUES
  ('🔴 IRS Installment',  3000.00,  1, 'NFCU Checking',   1, ARRAY[5,3,1,0], 'Form 9465 — DO NOT MISS. Drops balance ~$3k/mo toward Feb 2027 payoff.'),
  ('🏠 Rent (Willow Creek)', 1659.00, 1, 'NFCU Checking',   1, ARRAY[5,3,1,0], 'Largest fixed cost — late fee kicks in fast.'),
  ('🚗 Auto Loan (Cap One)', 617.00,  15, 'Cap One 360',    2, ARRAY[3,1,0],   'Pay off early in Phase 4 (post-IRS).'),
  ('🛡️ Auto Insurance',     477.00, 10, 'Cap One 360',    3, ARRAY[3,1,0],   'SHOP THIS — quote Progressive/GEICO/State Farm to save $150-200/mo.'),
  ('📱 T-Mobile',           163.00,  20, 'BofA',           4, ARRAY[3,1],     'Negotiate to $35-100/mo or switch to Mint/Visible.'),
  ('🛰️ Starlink',            75.00,  18, 'OE Federal',     4, ARRAY[3,1],     ''),
  ('⚡ NV Energy',            87.00,  25, 'BofA',           4, ARRAY[3,1],     '')
ON CONFLICT DO NOTHING;

-- ── HABITS ──────────────────────────────────────────────────────────────────
-- 5 starter habits tied directly to Dave's roadmap leaks + brand goals
INSERT INTO habits (name, emoji, target, cadence)
VALUES
  ('No ATM cash',         '💵', 'Under $75 cash withdrawn this week',  'daily'),
  ('Post @dadailydougie', '📸', '1 piece of content posted',           'daily'),
  ('Workout',             '💪', 'Lift, walk, or stretch — 30 min',     'daily'),
  ('No casino',           '🚫', 'Zero gambling / lottery spend',       'daily'),
  ('Sleep 7+ hrs',        '😴', 'In bed by 11 PM',                     'daily')
ON CONFLICT (name) DO NOTHING;

-- ── INITIAL JOURNAL ENTRY ──────────────────────────────────────────────────
-- Marks the moment Alfred v3 went live so Sunday's review has a starting point
INSERT INTO journal (entry_date, body, mood)
VALUES (CURRENT_DATE,
  'Alfred v3 went live today. Quick capture, IRS countdown, bill reminders, habits, journal, weekly reviews — the full butler. Mission: stay on the Feb 2027 IRS payoff line and grow @dadailydougie.',
  8)
ON CONFLICT (entry_date) DO NOTHING;
