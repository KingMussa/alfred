# Alfred — Status

**Version: v3-robust  · Last upgrade: 2026-05-26**
**Live since: 2026-05-23**

Supabase project `alfred` (ref `rwhfueaclqcunnoraaix`, us-east-1).

## What Alfred does now

| Capability | Triggered by | Notes |
|---|---|---|
| **Morning briefing** | Cron 10:00 UTC (6 AM ET) | Weather + IRS countdown + bills due + habit streaks + yesterday's captures + AI narrative of news/calendar/email |
| **Evening digest** | Cron 01:00 UTC (9 PM ET) | Today's captures, open todos, habit check, tomorrow's calendar, journal prompt |
| **Email recap** | Cron 22:00 UTC (6 PM ET) | Urgent emails ≥8/10 from last 12h |
| **Calendar reminders** | Cron */15 min | 1 hr + 15 min before each event |
| **Bill reminders** | Cron 12:00 UTC (8 AM ET) | 5d/3d/1d/day-of before each active bill |
| **Health check (dead-man)** | Cron :07 hourly | Verifies each scheduled fn ran on time; alerts Dave if not. Quiet-hours aware. |
| **Weekly review** | Cron 23:00 UTC Sun (7 PM ET) | Wins, captures, habit streaks, IRS progress, next week's #1 |
| **Two-way Telegram** | Webhook (Telegram → edge fn) | Slash commands + free-form chat with rolling 14-day memory |

## pg_cron jobs

| jobid | name | schedule (UTC) |
|---|---|---|
| 1 | purge-old-emails | `0 3 * * *` |
| 2 | morning-briefing | `0 10 * * *` |
| 3 | email-checker | `0 22 * * *` |
| 4 | calendar-reminder | `*/15 * * * *` |
| 6 | evening-digest | `0 1 * * *` |
| 7 | bill-reminder | `0 12 * * *` |
| 8 | health-check | `7 * * * *` |
| 9 | weekly-review | `0 23 * * 0` |
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

## Telegram slash commands (v3)

```
SYSTEM        /help /status /version /quiet 22:00-06:30

CAPTURE       /note /idea /todo /todos /done <id>
              /win /jobsite /quote /captures

FINANCIAL     /irs        — countdown to Feb 2027
              /pay <amt>  — record IRS payment
              /bills      — due in 14 days
              /spending   — vs monthly caps
              /expense <amt> <category> [note]

HABITS        /habits · /habit <name>
JOURNAL       /journal [mood:N] <text>

BRIEFINGS     /briefing /digest /recap /news /calendar /urgent

REVIEW        /review /skip /progress /execute (existing contact cleanup)
```

Plain text → AI conversation with the last 6 turns of memory + full
context (calendar, emails, news, IRS, todos, habits).

## Data tables (v3)

`captures · expenses · spending_limits · bills · bill_reminders_sent ·
irs_progress · habits · habit_logs · journal · conversation_memory ·
audit_log · health_checks · cost_log · weather_cache · content_ideas ·
preferences`

RLS enabled on every table (edge functions use service_role so they
bypass; anon clients are blocked).

## Seeded data

- **Bills** (7): IRS $3000 (1st), Rent $1659 (1st), Auto Loan $617 (15th),
  Auto Insurance $477 (10th), T-Mobile $163 (20th), Starlink $75 (18th),
  NV Energy $87 (25th)
- **Habits** (5): No ATM cash, Post @dadailydougie, Workout,
  No casino, Sleep 7+ hrs
- **IRS**: $25,000 balance, $7,000 paid (initial seed)
- **Quiet hours**: 22:00 → 06:30 ET (no alerts in this window)

## Stack

Supabase Edge Functions (Deno/TS) + Postgres + pg_cron + pg_net +
Twilio (via Gmail→SMS gateway) + Telegram Bot API + Gmail API +
Google Calendar + iCloud CalDAV + Open-Meteo (weather) +
Claude Haiku (primary) / Gemini 2.5 Flash (fallback).

## Secrets set

- `GEMINI_API_KEY` · `ANTHROPIC_API_KEY` (optional)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`
- `FROM_EMAIL` / `USER_CELL_GATEWAY` (Gmail→SMS path)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET`
- `USER_PHONE_NUMBER`
- `ICLOUD_APP_PASSWORD` — *unset* (optional)

## DST note

Cron schedules are in UTC tuned for EDT (UTC-4). On **2026-11-01**
when clocks fall back to EST (UTC-5), shift ALL ET-anchored crons by
+1 hour:
- morning-briefing: `0 10 * * *` → `0 11 * * *`
- email-checker:    `0 22 * * *` → `0 23 * * *`
- evening-digest:   `0 1 * * *`  → `0 2 * * *`
- bill-reminder:    `0 12 * * *` → `0 13 * * *`
- weekly-review:    `0 23 * * 0` → `0 0 * * 1`

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
