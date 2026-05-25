# Dave Assistant

A fully autonomous personal assistant that runs 24/7 in the cloud — no computer required.

## What it does

| Feature | Schedule |
|---|---|
| Morning briefing — top news, today's calendar, overnight emails | 7:00 AM daily |
| Email monitor — scans Gmail, texts urgent items (score 8+/10) | Every 30 minutes |
| Calendar reminders — texts 1 hour and 15 minutes before events | Every 15 minutes |

## How it works

- **Compute**: Supabase Edge Functions (Deno/TypeScript, serverless)
- **Scheduler**: Supabase pg_cron calls each function on a timer
- **Database**: Supabase Postgres stores processed emails and sent reminders (so nothing fires twice)
- **AI**: Google Gemini 2.0 Flash (free tier) scores email urgency and writes the morning briefing
- **SMS**: Twilio sends texts to your phone
- **Email**: Gmail API (bklyncaviar@gmail.com + iCloud forwarded in)
- **Calendar**: Google Calendar API + iCloud CalDAV

## Project structure

```
dave-assistant/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   └── 001_schema.sql          # DB tables + cleanup cron
│   └── functions/
│       ├── _shared/                # Shared modules
│       │   ├── types.ts
│       │   ├── ai.ts               # Google Gemini AI wrapper
│       │   ├── twilio.ts           # SMS sender
│       │   ├── gmail.ts            # Gmail API reader
│       │   ├── calendar.ts         # Google + iCloud CalDAV
│       │   ├── news.ts             # BBC/NPR RSS parser
│       │   └── db.ts               # Supabase database helpers
│       ├── morning-briefing/       # 7 AM daily digest
│       ├── email-checker/          # 30-min email monitor
│       └── calendar-reminder/      # 15-min event reminders
├── scripts/
│   ├── get-google-tokens.ts        # One-time OAuth setup
│   └── setup-cron.sql              # Run after deploying functions
├── .env.example
└── SETUP.md                        # Full step-by-step setup guide
```

## Setup

See **[SETUP.md](SETUP.md)** for the full step-by-step guide.

## Cost estimate

| Service | Cost |
|---|---|
| Supabase | Free tier (500MB DB, 500K function invocations/mo) |
| Twilio number | ~$1/month |
| Twilio SMS | ~$0.0079/message (~$3–5/month) |
| Google Gemini (free tier) | $0 — well under the 1500 req/day free limit |
| Total | **~$2/month** |
