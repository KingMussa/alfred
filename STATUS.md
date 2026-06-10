# Alfred — Status

**Version: v8 — field capture + tax guardrail  · Last upgrade: 2026-06-09**
**Live since: 2026-05-23**

## v8 (2026-06-09) — Income tracking + tax-reserve guardrail
- **The 1099 protection** against a repeat IRS hole. Solar (Sunrun) commission is 1099/untaxed.
- New `income` table + `_shared/income.ts`. Log income by stream: **`/income <amt> <stream>`** (union/solar/creative/spouse/other). 1099 streams (solar, creative) **auto-reserve a % (default 30) into a running tax set-aside**; W2 doesn't.
- **`/tax`** — reserve total, 1099 income YTD, income by stream, next estimated-tax date (15 Apr/Jun/Sep/Jan). **`/taxrate <pct>`** — set the rate (stored in `preferences.tax_reserve_pct`).
- `morning-briefing` surfaces an estimated-tax reminder within 10 days of a due date.

## v7 (2026-06-09) — Image-pipeline hardening + MEP broadening
- **Reliability:** idempotency via `processed_updates` (dedupe Telegram retries); photo/voice/PDF now ack 200 instantly and process in `EdgeRuntime.waitUntil` (no retry-dupes during 15-40s Claude reads); retry/backoff on Gemini (429/500/503/529) and Claude vision; **Gemini-failure falls back to Claude** so a read never hard-fails.
- **Blueprint reader broadened VRF → general MEP** (piping/ductwork/equipment; VRF is a subset). Reads via **Claude Opus 4.8 vision**, gated to blueprints. **PDF support** (Claude document blocks). `/blueprints`, `/bp <id>`.
- **Image compression** (`_shared/compress.ts`, ImageScript) — resize big jobsite files to 2560px before vision + storage (stays under Anthropic's 5MB limit). **Base64** switched to std `encodeBase64` (the chunked-spread form overflowed the edge runtime's stack on multi-MB images).
- **Durable image archive** to private Supabase Storage bucket `alfred-docs` (`documents.storage_path`); `/bp <id>` re-sends the stored sheet.
- **Engine fix** (`_shared/ai.ts`): real Claude→Gemini fallback (was dead) + retry on {429,500,529}.
- **Safer auto-expense:** receipts under 0.6 confidence no longer auto-log — Alfred replies a `/expense` to confirm.
- **Ops:** Gmail `GOOGLE_REFRESH_TOKEN` regenerated; OAuth consent screen **published to production** (kills the 7-day testing-mode token expiry). New tables: `processed_updates`, `income`; new column `documents.storage_path`; bucket `alfred-docs`.

## v6 (2026-06-09) — Field capture: voice notes + VRF blueprint reading
- **Voice notes** — tap-and-hold the mic in Telegram → Gemini 2.5 Flash transcription → routed through the *same* command router as typed text. Spoken intent words ("todo …", "note …", "spent …") map to the matching slash command; the reply echoes the transcript so Dave can trust it. New `_shared/voice.ts`; no new secret (reuses `GEMINI_API_KEY`).
- **VRF blueprint reader** — snap/send a refrigerant piping print → structured extraction tuned to Dave's trade: RL/RG line size + BOI elevation per run, indoor-unit tags + AFF, BC controllers / CMY branch joints, UP/DN risers, red-pen hanger markups, handwritten field notes. `/blueprints` (or `/bp`) lists recent. Stored in the existing `documents` table (`doc_type='blueprint'`) — **no migration**.
- **Blueprints read via Claude Opus 4.8 vision** (not Gemini) for jobsite-grade accuracy — gated to blueprints only by `readDocument()`; receipts/statements stay on free Gemini. Falls back to Gemini if Claude errors. Best capture: send as a **FILE** (full-res), shot flat + lit, one area at a time.
- **Engine fix** (`_shared/ai.ts`) — real Claude→Gemini fallback (was dead — `claudeChat` threw and never fell through) and retries `{429,500,529}` (was the dead `529||529`).
- Deployed to **`telegram-webhook`** (live, smoke-tested 403/405). The 4 cron fns (morning-briefing, evening-digest, email-checker, weekly-review) still need a redeploy to pick up the `ai.ts` fallback fix.
- Commits authored as **BATCAVE <bklyncaviar@gmail.com>**, pushed to `KingMussa/alfred`.

## v5 (2026-06-09) — Pay Dashboard V5 + car note payoff
- 🎉 **Capital One Auto Loan PAID IN FULL (2026-06-09)** — liability #2 zeroed & deactivated, $617/mo bill deactivated. Insurance ($477/mo, due 10th) still active — shop it next.
- **IRS corrected to EXACT transcript amounts (same day)**: 2023 $6,465.59 · 2024 $23,166.91 · 2025 $3,035.36 = **$32,667.86** (was $25k estimate). `~/Documents/alfred_irs_balance.txt` updated — Tuesday brief picks it up automatically.
- **Net worth**: −$14,218 → **−$6,886** (+$7,332 net: car −$15k debt, IRS +$7.7k correction). Payoff at $3k/mo lands ~May 2027; routing the freed $617/mo to IRS (~$3.6k/mo) pulls it back toward Feb 2027.
- New **Money Mission Control** Cowork artifact (`money-mission-control`) — persisted dashboard with live Supabase refresh: net worth trend, debt demolition, goal buckets, spending caps + breakdown, ACCO work-pay section (V5), and document drop-in module wired to the alfred_inbox image pipeline
- Remaining debt: IRS $25,000 only · freedom date Feb 2027 unchanged
- Freed $617/mo → candidate seed for Emergency Fund (could start Phase 2 ~8 months early)

## v4 (2026-05-26) — Wealth modeling + investments + decisions
- Net worth tracker (8 assets, 2 liabilities seeded → current NW $−14,218)
- Daily net worth snapshots with 7d/30d/since-start deltas
- Debt payoff calculator (IRS Feb 2027 on track, Auto Loan needs balance confirm)
- Goal buckets (Emergency Fund $15k, House Down $40k, Roth IRA $7k, Triple D $6k)
- 90-day cash-flow forecast with danger-date detection
- Daily safe-to-spend allowance (pace-aware)
- Portfolio + trades (Robinhood seeded empty, FMP free tier for live quotes)
- Decision log with 30-day auto-review
- `/analyze` — AI-driven monthly financial diagnostic
- 13 new Telegram commands (see full list below)

Supabase project `alfred` (ref `rwhfueaclqcunnoraaix`, us-east-1).

## What Alfred does now

| Capability | Triggered by | Notes |
|---|---|---|
| **Morning briefing** | Cron 12:00 UTC (5 AM PT — Reno) | Weather + IRS countdown + bills due + habit streaks + yesterday's captures + AI narrative |
| **Evening digest** | Cron 04:00 UTC (9 PM PT) | Today's captures, open todos, habit check, tomorrow's calendar, journal prompt |
| **Email recap** | Cron 01:00 UTC (6 PM PT) | Urgent emails ≥8/10 from last 12h |
| **Calendar reminders** | Cron */15 min | 1 hr + 15 min before each event |
| **Bill reminders** | Cron 15:00 UTC (8 AM PT) | 5d/3d/1d/day-of before each active bill |
| **Health check (dead-man)** | Cron :07 hourly | Verifies each scheduled fn ran on time; alerts Dave if not. Quiet-hours aware. |
| **Weekly review** | Cron Mon 02:00 UTC (Sun 7 PM PT) | Wins, captures, habit streaks, IRS progress, next week's #1 |
| **Two-way Telegram** | Webhook (Telegram → edge fn) | Slash commands + free-form chat with rolling 14-day memory |

## pg_cron jobs

| jobid | name | schedule (UTC) |
|---|---|---|
| 1 | purge-old-emails | `0 3 * * *` |
| 2 | morning-briefing | `0 12 * * *` (5 AM PT) |
| 3 | email-checker | `0 1 * * *` (6 PM PT) |
| 4 | calendar-reminder | `*/15 * * * *` |
| 6 | evening-digest | `0 4 * * *` (9 PM PT) |
| 7 | bill-reminder | `0 15 * * *` (8 AM PT) |
| 8 | health-check | `7 * * * *` (hourly) |
| 9 | weekly-review | `0 2 * * 1` (Sun 7 PM PT) |
| 18 | daily-networth | `0 6 * * *` (11 PM PT) |
| 10 | purge-conversation | `30 3 * * *` |
| 11 | purge-telemetry | `45 3 * * 0` |

## Edge functions deployed

| Function | verify_jwt | Notes |
|---|---|---|
| `morning-briefing` | ✓ | v3 — full intel header |
| `evening-digest` | ✓ | NEW v1 |
| `email-checker` | ✓ | v3 — now audits |
| `calendar-reminder` | ✓ | v2 — now audits |
| `bill-reminder` | ✓ | NEW v1 |
| `health-check` | ✓ | NEW v2 — quiet-hours aware |
| `weekly-review` | ✓ | NEW v1 |
| `telegram-webhook` | ✗ | Uses X-Telegram-Bot-Api-Secret-Token |

## Telegram slash commands (v4)

```
SYSTEM       /help /status /version /quiet 22:00-06:30

CAPTURE      /note /idea /todo /todos /done /win /jobsite /line /captures

FINANCIAL    /irs · /pay <amt> · /bills · /spending
DAY-TO-DAY   /expense <amt> <cat> [note]
             /cash       — today's safe-to-spend
             /forecast   — 90-day projection w/ danger dates

WEALTH (v4)  /net        — net worth + 7d/30d/start deltas
             /assets · /asset <id> <bal>
             /debts · /debt <id> <bal>
             /payoff     — debt payoff projection per liability
             /goals · /goal <name> $<amt> by <date>
             /goal fund <name> $<amt>

INVESTMENTS  /quote <symbol>            — live price (requires FMP_API_KEY)
(v4)         /portfolio                  — holdings + P&L
             /buy <sym> <qty> @<price>
             /sell <sym> <qty> @<price>

DECISIONS    /decide <what> :: <why> :: <expected outcome>
(v4)         /decisions                  — last 10

ANALYSIS     /analyze    — AI monthly financial diagnostic

HABITS       /habits · /habit <name>
JOURNAL      /journal [mood:N] <text>

BRIEFINGS    /briefing /digest /recap /news /calendar /urgent
REVIEW       /review /skip /progress /execute
```

Plain text → AI conversation with the last 6 turns of memory + full
context (calendar, emails, news, IRS, todos, habits).

## Data tables (v4 — 24 total)

v3 base (16): captures · expenses · spending_limits · bills ·
bill_reminders_sent · irs_progress · habits · habit_logs · journal ·
conversation_memory · audit_log · health_checks · cost_log ·
weather_cache · content_ideas · preferences

v4 wealth (8): **assets · liabilities · net_worth_snapshots ·
goal_buckets · holdings · trades · decisions · quote_cache**

RLS enabled on every table (edge functions use service_role so they
bypass; anon clients are blocked).

## Seeded data

- **Bills** (7): IRS $3000 (1st), Rent $1659 (1st), Auto Loan $617 (15th),
  Auto Insurance $477 (10th), T-Mobile $163 (20th), Starlink $75 (18th),
  NV Energy $87 (25th)
- **Habits** (5): No ATM cash, Post @dadailydougie, Workout,
  No casino, Sleep 7+ hrs
- **IRS**: $25,000 balance, $7,000 paid (initial seed)
- **Quiet hours**: 22:00 → 06:30 PT (no alerts in this window)

## Stack

Supabase Edge Functions (Deno/TS) + Postgres + pg_cron + pg_net +
Twilio (via Gmail→SMS gateway) + Telegram Bot API + Gmail API +
Google Calendar + iCloud CalDAV + Open-Meteo (weather) +
Claude Haiku (primary) / Gemini 2.5 Flash (fallback).

## Secrets set

- `GEMINI_API_KEY` · `ANTHROPIC_API_KEY` (optional)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRPT` / `GOOGLE_REFRESH_TOKEN`
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`
- `FROM_EMAIL` / `USER_CELL_GATEWAY` (Gmail→SMS path)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRPT`
- `USER_PHONE_NUMBER`
- `ICLOUD_APP_PASSWORD` — *unset* (optional)
- `FMP_API_KEY` — *unset* (v4: enables /quote + /portfolio live prices. Free 250/day at financialmodelingprep.com)

## DST note (Pacific Time — Reno NV)

Cron schedules are tuned for **PDT (UTC-7)** as of 2026-05-26. On
**2026-11-01** when clocks fall back to **PST (UTC-8)**, shift ALL
PT-anchored crons by +1 hour UTC:
- morning-briefing: `0 12 * * *` → `0 13 * * *`
- email-checker:    `0 1 * * *`  → `0 2 * * *`
- evening-digest:   `0 4 * * *`  → `0 5 * * *`
- bill-reminder:    `0 15 * * *` → `0 16 * * *`
- weekly-review:    `0 2 * * 1`  → `0 3 * * 1`
- daily-networth:   `0 6 * * *`  → `0 7 * * *`

## Location

Dave is in **Reno, Nevada**. Weather coords in `_shared/weather.ts`:
39.5296, -119.8138. All formatting uses `America/Los_Angeles` timezone.
Previously stored as NYC — corrected from the 2026-05-26 ChatGPT handoff.

## Known advisories (informational)

- `pg_net` extension lives in `public` schema — moving it is risky
  because cron jobs reference it. Left as-is.

## If SMS stops arriving

Telegram is the primary channel (free, no carrier filtering). Gmail→SMS
gateway is the backup. If both die, check audit_log:

```sql
SELECT * FROM audit_log WHERE status != 'ok' ORDER BY id DESC LIMIT 20;
SELECT * FROM health_checks WHERE ok = false ORDER BY id DESC LIMIT 20;
```

## Reference

- Project folder: `/Users/sankore/Documents/Work/Claude Batcave/dave-assistant/`
- Setup guide: `ALFRED-MANUAL.md`
- AI wrapper: `supabase/functions/_shared/ai.ts` (`aiChat`)
- Shared modules: `supabase/functions/_shared/{ai,calendar,capture,db,finance,gmail,memory,news,notify,telegram,twilio,types,weather}.ts`
