# Alfred — Operations Manual

> Your personal AI butler. Texts you news in the morning, flags urgent emails, reminds you about meetings. Runs 24/7 in the cloud — your Mac doesn't have to be on.

**Status as of 2026-05-23 (evening): ✅ LIVE.** Alfred is deployed on Supabase, sending SMS to Dave's phone via Gmail → T-Mobile gateway. All 4 cron jobs scheduled. End-to-end smoke test passed. **Actual monthly cost: $0** (Gmail-gateway path is free; Twilio number is unused now and can be released).

> The checklist below is left intact as the historical setup log. ✅ = done, ⏭️ = skipped (not blocking), 🔁 = replaced by a better path mid-build.

---

## What Alfred does

| When | What he does |
|---|---|
| 7:00 AM daily | Texts you a morning briefing — top 5 news stories, today's calendar, overnight emails |
| Every 30 min | Scans Gmail. If an email scores 8+/10 for urgency, texts you immediately |
| Every 15 min | Texts you 1 hour before meetings, then 15 min before |

---

## Heads up — don't mix these up

| Thing | What it's for | Status |
|---|---|---|
| **Claude Code CLI** (the `claude` command) | A tool *for you* to chat with Claude from a terminal — uses your Claude.ai login | ✅ Installed 2026-05-23 |
| **Gemini API key** (from aistudio.google.com) | A credential *for Alfred* so he can use Google's AI — **100% free, no credit card** | ⬜ Step 7 below |

Note: Alfred originally used Claude AI, but that requires a paid Anthropic account. We swapped him to **Google Gemini's free tier** on 2026-05-23 so you can run him at $0/month for the AI part. Gemini 2.0 Flash is plenty smart for what Alfred does (scoring emails 1–10, writing a 3-paragraph briefing).

---

## The Checklist

Open this file and check boxes as you go. Each step is independent — you can do one a day if you want.

### ✅ Step 1 — Install Supabase CLI and Deno (5 min) — *DONE 2026-05-23*

These are the tools that talk to the cloud host (Supabase) and run the bot code (Deno).

Open **Terminal.app** and paste:

```
brew install supabase/tap/supabase deno
```

Wait until it finishes. Verify:

```
supabase --version
deno --version
```

Both should print a version number.

---

### ✅ Step 2 — Create a Supabase account + project (10 min) — *DONE 2026-05-23*

Supabase = the cloud that hosts Alfred for free.

1. Go to **https://supabase.com** → Sign up (use `dougiedigital@icloud.com`)
2. Click **New project**
3. Name it: `alfred`
4. Region: **East US (North Virginia)** — closest to NY
5. **Generate a database password** → save it in your password manager
6. Wait ~2 minutes for it to spin up
7. Go to **Settings → General** → copy the **Reference ID** (looks like `abcdefghijkl`)

**Save this:**
- Supabase Reference ID: `__________________`
- Database password: (in password manager)

---

### ⏭️ Step 3 — Forward iCloud Mail to Gmail (5 min) — *SKIPPED 2026-05-23*

> **Skipped because:** iCloud's web UI for forwarding wasn't behaving. Alfred will only watch `bklyncaviar@gmail.com` for now. If you want him to see iCloud mail later, easier alternative: in Gmail → Settings → Accounts → **"Check mail from other accounts"** → add `dougiedigital@icloud.com` (requires an iCloud app-specific password). Or just forward important emails manually.

iCloud email has no API. So we forward it to Gmail, and Alfred reads Gmail.

1. On Mac, go to **https://icloud.com/mail** → sign in
2. Click the gear icon → **Preferences → Rules**
3. Add rule: **If: all messages → Then: forward to `bklyncaviar@gmail.com`**
4. Save

Send yourself a test email to `dougiedigital@icloud.com` and confirm it shows up in Gmail within a minute.

---

### ✅ Step 4 — Google API setup (15 min) — *DONE 2026-05-23*

> **What was done:**
> - Created Google Cloud project `alfred` (Project ID: `imperial-berm-497301-i7`)
> - Enabled Gmail API + Google Calendar API
> - Configured OAuth consent screen (External, Testing mode, app name "Alfred")
> - Added `bklyncaviar@gmail.com` as test user
> - Created OAuth 2.0 Desktop client "Alfred" — credentials in `credentials/google-oauth.json`
> - Generated refresh token via local-server OAuth flow — saved in `.env.local` as `GOOGLE_REFRESH_TOKEN`
> - Scopes granted (read-only): `gmail.readonly`, `calendar.readonly`

This lets Alfred read your Gmail and Google Calendar.

1. Go to **https://console.cloud.google.com** → sign in with `bklyncaviar@gmail.com`
2. Top bar → **Create a new project** → name it `alfred` → Create
3. Left menu → **APIs & Services → Library**
4. Search & **Enable** these two:
   - Gmail API
   - Google Calendar API
5. Left menu → **APIs & Services → OAuth consent screen**
   - User type: **External** → Create
   - App name: Alfred → User support email: your Gmail → Save
6. Left menu → **APIs & Services → Credentials**
   - **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Desktop app** → Name: Alfred → Create
   - **Copy** the Client ID and Client Secret

**Now generate a refresh token** — open Terminal, navigate to the project folder, run the token script:

```
cd "/Users/sankore/Documents/Work/Claude Batcave/dave-assistant"
deno run --allow-net scripts/get-google-tokens.ts
```

Follow the prompts. It'll print a **refresh token** — copy it.

**Save these three things:**
- Google Client ID: `__________________`
- Google Client Secret: `__________________`
- Google Refresh Token: `__________________`

---

### 🔁 Step 5 — Twilio (15 min) — *REPLACED 2026-05-23 with Gmail → T-Mobile gateway*

> **What actually happened:** Twilio's toll-free number (+1 855-464-9778) hit Error 30032 "Toll-Free Verification Required" — a US carrier rule that takes 1–3 weeks to clear and applies regardless of paid/trial account.
>
> **The fix that shipped:** Alfred sends an email from `bklyncaviar@gmail.com` to `9175182963@tmomail.net` (T-Mobile's free email-to-SMS gateway). T-Mobile relays it as a real text on Dave's phone. **No Twilio, no verification, $0/mo.** The Gmail OAuth scope was expanded from read-only to also include `gmail.send` (via a re-run of `scripts/get-google-tokens.ts`).
>
> Code lives in `_shared/twilio.ts` (filename kept, internals rewritten to use Gmail API). Twilio secrets are still in Supabase but unused; the toll-free number can be released to drop the $1/mo charge.

Twilio = the service that sends Alfred's text messages to your phone.

1. Go to **https://www.twilio.com** → Sign up (free trial gives you $15 credit)
2. Verify your phone number when prompted
3. From the dashboard → **Phone Numbers → Buy a number**
   - Country: US, Capabilities: SMS, price: ~$1/month
   - Buy one — pick any area code
4. From the main dashboard, copy three things:

**Save these:**
- Twilio Account SID: `AC__________________`
- Twilio Auth Token: `__________________`
- Twilio phone number: `+1__________________`
- Your cell phone number: `+1__________________`

---

### ⏭️ Step 6 — iCloud app-specific password (3 min) — *NOT BLOCKING*

> Optional. Alfred's calendar logic gracefully skips iCloud if this isn't set. Google Calendar alone is enough for reminders. Add later if you want Apple Calendar events too.

So Alfred can read your iCloud calendar.

1. Go to **https://appleid.apple.com** → sign in
2. Left menu → **Sign-In and Security → App-Specific Passwords**
3. Click **+** → name it `Alfred` → Continue
4. Apple gives you a password like `xxxx-xxxx-xxxx-xxxx` — **copy it now**, you can't see it again

**Save this:**
- iCloud App Password: `__________________`

---

### ✅ Step 7 — Google Gemini API key — FREE (3 min) — *DONE 2026-05-23*

> Dave got the key himself after Google's bot detection blocked the automated click. Saved to `.env.local` as `GEMINI_API_KEY`. Using **gemini-2.5-flash** model (free tier — 2.0-flash was dropped from free tier in 2026).

This is the credential Alfred uses for AI (ranking emails and writing your briefing). Google's free tier gives you way more than Alfred needs — **no payment method required**.

1. Go to **https://aistudio.google.com/apikey** → sign in with `bklyncaviar@gmail.com` (same Google account from Step 4)
2. Click **Create API key** → pick the `alfred` project you made earlier (or create a new project)
3. Copy the key — it starts with `AIza`

That's it. No billing, no credit card, no limits to worry about (the free tier is 1,500 requests/day; Alfred uses maybe 30/day).

**Save this:**
- Gemini API Key: `AIza__________________`

---

### ✅ Step 8 — Deploy Alfred to the cloud (15 min) — *DONE 2026-05-23*

> All 3 Edge Functions deployed via `supabase functions deploy ...`. Secrets pushed: `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`, `FROM_EMAIL`, `USER_CELL_GATEWAY`, plus legacy Twilio vars (unused now). Project ref: `rwhfueaclqcunnoraaix` (us-east-1). Functions URL: `https://rwhfueaclqcunnoraaix.supabase.co/functions/v1/<name>`.

This is the moment where everything you saved gets glued together. Open Terminal:

```
cd "/Users/sankore/Documents/Work/Claude Batcave/dave-assistant"

# Log into Supabase
supabase login

# Link to your project (paste the Reference ID from Step 2)
supabase link --project-ref YOUR_REF_ID_HERE

# Push the database schema
supabase db push
```

Now paste your saved values into these commands — **one line at a time**:

```
supabase secrets set GOOGLE_CLIENT_ID=paste_here
supabase secrets set GOOGLE_CLIENT_SECRET=paste_here
supabase secrets set GOOGLE_REFRESH_TOKEN=paste_here
supabase secrets set ICLOUD_EMAIL=dougiedigital@icloud.com
supabase secrets set ICLOUD_APP_PASSWORD=paste_here
supabase secrets set TWILIO_ACCOUNT_SID=paste_here
supabase secrets set TWILIO_AUTH_TOKEN=paste_here
supabase secrets set TWILIO_FROM_NUMBER=+1_paste_here
supabase secrets set USER_PHONE_NUMBER=+1_your_cell
supabase secrets set GEMINI_API_KEY=AIza_paste_here
```

Now deploy the three brains:

```
supabase functions deploy morning-briefing
supabase functions deploy email-checker
supabase functions deploy calendar-reminder
```

---

### ✅ Step 9 — Schedule the cron jobs (5 min) — *DONE 2026-05-23*

> All 4 pg_cron jobs active in Supabase:
> - `purge-old-emails` — `0 3 * * *` (3 AM UTC daily)
> - `morning-briefing` — `0 11 * * *` (7 AM EDT = 11 AM UTC) — **switch to `0 12 * * *` after 2026-11-01 when EST returns**
> - `email-checker` — `*/30 * * * *` (every 30 min)
> - `calendar-reminder` — `*/15 * * * *` (every 15 min)

This is what makes Alfred run on his own.

1. Open **`scripts/setup-cron.sql`** in TextEdit or VS Code
2. Replace `YOUR_PROJECT_REF` with the Reference ID from Step 2
3. Get your **Anon key** from Supabase: Settings → API → `anon public` key
4. Replace `YOUR_ANON_KEY` with that
5. Save the file
6. In Supabase dashboard → **SQL Editor** → paste the whole file contents → click **Run**

---

### ✅ Step 10 — Test it (5 min) — *DONE 2026-05-23, SMS DELIVERED*

> Smoke test confirmed end-to-end: `supabase functions invoke morning-briefing` → Gmail sent → T-Mobile gateway → text arrived on Dave's phone. **Alfred is live.**

Don't wait for the schedule — invoke each function manually to make sure it works:

```
supabase functions invoke morning-briefing
supabase functions invoke email-checker
supabase functions invoke calendar-reminder
```

You should get a text on your phone within ~30 seconds. **If you do — Alfred is alive.** 🎉

---

## After Alfred is running

### How to know he's working
- You'll get a text at 7 AM every morning
- Send yourself an urgent-sounding email and wait up to 30 min for a text
- Put a test event on your calendar starting in 1 hour and wait for the reminder

### Where to check if something seems off
| Question | Where to look |
|---|---|
| Did Alfred run today? | Supabase dashboard → **Database → cron.job_run_details** |
| Why didn't I get a text? | Supabase dashboard → **Edge Functions → click function → Logs** |
| What emails got texted to me? | Supabase dashboard → **Table Editor → `sms_log`** |
| What's my Twilio balance? | Twilio dashboard (refill at $5 if it gets low) |
| Am I close to Gemini's free tier limit? | aistudio.google.com → Usage (Alfred won't get close) |

### Adjusting Alfred
| Want to change... | Edit this file |
|---|---|
| Briefing time (currently 7 AM ET) | `scripts/setup-cron.sql` — the `0 12 * * *` (12 UTC = 7 AM ET in winter, 11 UTC in summer) |
| Urgency threshold for emails | `supabase/functions/email-checker/index.ts` — search for `score >= 8` |
| How many news stories | `supabase/functions/morning-briefing/index.ts` — search for `getTopNews(5)` |

After editing any function file, redeploy:
```
supabase functions deploy <function-name>
```

---

## Monthly costs (estimate)

| Service | Cost |
|---|---|
| Supabase | $0 — free tier covers this easily |
| Twilio phone number | ~$1 |
| Twilio texts (~3–5/day) | ~$1 |
| Google Gemini AI | **$0 — free tier** |
| **Total** | **~$2 / month** |

---

## If you get stuck

Open Terminal, navigate here:
```
cd "/Users/sankore/Documents/Work/Claude Batcave/dave-assistant"
claude
```

Then tell Claude: *"I'm on step X of the Alfred manual and stuck — here's what happened: ..."* — I'll have full context.
