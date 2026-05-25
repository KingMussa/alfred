# Alfred — Status

**Live since: 2026-05-23**

Supabase project `alfred` (ref `rwhfueaclqcunnoraaix`, us-east-1).

## Active pg_cron jobs

| Job | Schedule (UTC) | Purpose |
|---|---|---|
| `morning-briefing` | `0 11 * * *` | 7 AM EDT daily briefing (news + calendar + overnight emails) |
| `email-checker` | `*/30 * * * *` | Scan Gmail, text urgent emails (score ≥ 8/10) |
| `calendar-reminder` | `*/15 * * * *` | Text 1 hr + 15 min before calendar events |
| `purge-old-emails` | `0 3 * * *` | Daily cleanup |

Each HTTP cron uses `net.http_post` with anon-key Bearer auth → `https://rwhfueaclqcunnoraaix.supabase.co/functions/v1/<fn>`.

## Stack

Supabase Edge Functions (Deno/TS) + Postgres + pg_cron + pg_net + Twilio SMS + Gmail API + Google Calendar + Gemini 2.5 Flash (free tier).

## Edge functions deployed

- `morning-briefing` (v13+)
- `email-checker` (v11+)
- `calendar-reminder` (v1)

## Secrets set

- `GEMINI_API_KEY`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`
- `USER_PHONE_NUMBER`
- `ICLOUD_APP_PASSWORD` — **unset** (optional; Apple Calendar gracefully skipped)

## DST note

`0 11 * * *` UTC is correct for EDT (UTC-4). On **2026-11-01** when clocks fall back, update `morning-briefing` to `0 12 * * *` so the briefing stays at 7 AM ET.

## If SMS stops arriving

Check Twilio Console → Monitor → Logs → Messages for delivery Status + Error Code. Likely culprit is A2P 10DLC carrier filtering; fixes are A2P 10DLC registration (slow but proper) or a toll-free number (faster, pricier).

## Reference

- Project folder: `/Users/sankore/Documents/Work/Claude Batcave/dave-assistant/`
- Setup guide: `ALFRED-MANUAL.md`
- AI wrapper: `supabase/functions/_shared/ai.ts` (`aiChat`)
