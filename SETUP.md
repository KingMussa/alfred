# Dave Assistant — Setup Guide

Follow these steps in order. Each one takes 5–10 minutes.

---

## Prerequisites

Install these tools first:
- **Supabase CLI**: `brew install supabase/tap/supabase`
- **Deno**: `brew install deno`
- A GitHub account (you already have one)

---

## Step 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in (or create a free account)
2. Click **New project**
3. Give it a name like `dave-assistant`, pick a region close to New York
4. Save the **database password** somewhere safe
5. Wait ~2 minutes for it to spin up
6. Go to **Settings → General** and copy your **Reference ID** (looks like `abcdefghijklmnop`)

---

## Step 2 — Forward iCloud Mail to Gmail

Your iCloud email (`dougiedigital@icloud.com`) doesn't have a public API, so we forward it to Gmail.

1. On your iPhone → **Settings → Mail → Accounts → iCloud**
2. Or go to [icloud.com/mail](https://icloud.com/mail) on your Mac
3. In iCloud Mail → **Settings (gear icon) → Preferences → Rules**
4. Add a rule: **All messages → Forward to → bklyncaviar@gmail.com**

That's it. The bot monitors Gmail for both accounts.

---

## Step 3 — Set Up Google API (Gmail + Calendar)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (name it anything)
3. In the left menu → **APIs & Services → Library**
4. Search and **Enable** these two APIs:
   - **Gmail API**
   - **Google Calendar API**
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → OAuth 2.0 Client ID**
7. Application type: **Desktop app** → name it `Dave Assistant` → Create
8. Download or copy the **Client ID** and **Client Secret**

Now run the token script:
```bash
deno run --allow-net scripts/get-google-tokens.ts
```
Follow the prompts. It will print your `GOOGLE_REFRESH_TOKEN` — copy it.

---

## Step 4 — Set Up Twilio (SMS)

1. Go to [twilio.com](https://twilio.com) and create a free account
2. In the Twilio Console, go to **Buy a number** → pick a US number (~$1/mo)
3. From your dashboard, copy:
   - **Account SID**
   - **Auth Token**
   - **Your Twilio phone number** (e.g. `+12125551234`)

---

## Step 5 — Set Up iCloud App Password (for Apple Calendar)

1. Go to [appleid.apple.com](https://appleid.apple.com) → **Security → App-Specific Passwords**
2. Click **+** → name it `Dave Assistant` → Generate
3. Copy the password (format: `xxxx-xxxx-xxxx-xxxx`)

---

## Step 6 — Get a Claude API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account and add a payment method (costs will be cents per day)
3. Go to **API Keys → Create Key** → copy it

---

## Step 7 — Link Supabase CLI and Deploy

```bash
# Log in to Supabase CLI
supabase login

# Link to your project (use the Reference ID from Step 1)
supabase link --project-ref YOUR_PROJECT_REF

# Run the database migration
supabase db push

# Set all your secrets (one command per secret)
supabase secrets set GOOGLE_CLIENT_ID=your_value
supabase secrets set GOOGLE_CLIENT_SECRET=your_value
supabase secrets set GOOGLE_REFRESH_TOKEN=your_value
supabase secrets set ICLOUD_EMAIL=dougiedigital@icloud.com
supabase secrets set ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=your_value
supabase secrets set TWILIO_FROM_NUMBER=+1xxxxxxxxxx
supabase secrets set USER_PHONE_NUMBER=+1xxxxxxxxxx
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx

# Deploy all three Edge Functions
supabase functions deploy morning-briefing
supabase functions deploy email-checker
supabase functions deploy calendar-reminder
```

---

## Step 8 — Set Up the Scheduled Jobs

1. In the Supabase dashboard → **SQL Editor**
2. Open the file `scripts/setup-cron.sql` in this repo
3. Replace `YOUR_PROJECT_REF` and `YOUR_ANON_KEY` with your actual values
   - Reference ID: Settings → General
   - Anon key: Settings → API → Project API Keys → `anon public`
4. Paste the SQL into the editor and click **Run**

**Default schedule:**
| Job | When |
|---|---|
| Morning briefing | 7:00 AM Eastern every day |
| Email checker | Every 30 minutes |
| Calendar reminder | Every 15 minutes |

To change the morning briefing time, edit the cron expression `0 12 * * *` where `12` = hour in UTC. Eastern Time = UTC−5 (winter) or UTC−4 (summer/EDT).

---

## Step 9 — Test It Manually

In the Supabase dashboard → **Edge Functions**, click each function and hit **Invoke** to test it now without waiting for the schedule.

Or via the CLI:
```bash
supabase functions invoke morning-briefing
supabase functions invoke email-checker
supabase functions invoke calendar-reminder
```

You should get a text message within seconds.

---

## Step 10 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial Dave Assistant bot"
git remote add origin https://github.com/YOUR_USERNAME/dave-assistant.git
git push -u origin main
```

**Never commit your `.env` file.** It's in `.gitignore` already. Secrets live only in Supabase.

---

## Monitoring & Logs

- **SMS log**: Supabase dashboard → Table Editor → `sms_log`
- **Email scores**: Table Editor → `processed_emails`
- **Function logs**: Edge Functions → click a function → Logs tab
- **Cron job status**: SQL Editor → `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;`

---

## Adjusting the Bot

| What | Where |
|---|---|
| Change briefing time | `scripts/setup-cron.sql` → change the cron expression |
| Change email urgency threshold | `email-checker/index.ts` → line with `score >= 8` |
| Change how many news stories | `morning-briefing/index.ts` → `getTopNews(5)` |
| Change reminder timing | `calendar-reminder/index.ts` → the `minUntil` ranges |
