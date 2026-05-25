/**
 * Telegram webhook — makes Alfred two-way.
 *
 * Telegram POSTs here whenever Dave sends a message to the bot. We:
 *   1. Verify the request came from Telegram (secret token in header)
 *   2. Verify it's from Dave's chat (chat_id matches TELEGRAM_CHAT_ID)
 *   3. Route slash commands (/recap, /news, /calendar, etc.) to handlers
 *   4. Route plain text to Gemini with full context (calendar, emails, news)
 *   5. Reply via Telegram sendMessage
 *
 * Deploy with --no-verify-jwt so Telegram can POST without a Supabase JWT;
 * we use TELEGRAM_WEBHOOK_SECRET instead.
 */

import { aiChat } from "../_shared/ai.ts";
import { getNewEmails, getTodaysEmails } from "../_shared/gmail.ts";
import { getUpcomingEvents } from "../_shared/calendar.ts";
import { getTopNews } from "../_shared/news.ts";
import { sendTelegram } from "../_shared/telegram.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ALLOWED_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const PROJECT_URL = "https://rwhfueaclqcunnoraaix.supabase.co";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const VERSION = "v1 (2026-05-23)";

// ---------------------------------------------------------------------------
// Slash command handlers — each returns the text to send back to Dave.
// ---------------------------------------------------------------------------

async function cmdStart(): Promise<string> {
  return [
    "🦇 Alfred here. I'm two-way now — you can text me anything.",
    "",
    "Quick commands:",
    "  /status — what's running, when's next",
    "  /briefing — fire the morning briefing right now",
    "  /recap — fire the evening urgent-email recap right now",
    "  /news — top 5 headlines",
    "  /calendar — today's remaining events",
    "  /urgent — scan inbox last hour, flag anything urgent",
    "  /help — show this menu",
    "  /version — code version",
    "",
    "Or just talk normally. Ask me anything — \"what's my next meeting,\" \"any emails from the IRS,\" \"give me content ideas for today.\" I'll do my best.",
  ].join("\n");
}

async function cmdStatus(): Promise<string> {
  const now = new Date();
  return [
    "📊 ALFRED STATUS",
    "",
    `Now: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
    `Version: ${VERSION}`,
    "",
    "Schedule:",
    "  • Morning briefing — 6:00 AM ET daily",
    "  • Evening email recap — 6:00 PM ET daily",
    "  • Calendar reminders — every 15 min",
    "",
    "Channels: Telegram only (SMS disabled by Dave's preference).",
    "AI: Gemini 2.5 Flash, free tier.",
  ].join("\n");
}

async function cmdBriefing(): Promise<string> {
  // Fire the morning-briefing function async — let Telegram know immediately
  fireAndForget(`${PROJECT_URL}/functions/v1/morning-briefing`);
  return "🌅 Firing morning briefing — it'll arrive in the next minute or so as a separate message.";
}

async function cmdRecap(): Promise<string> {
  fireAndForget(`${PROJECT_URL}/functions/v1/email-checker`);
  return "📬 Firing evening recap — checking last 12h for urgent emails. If anything scores 8+ you'll get a separate message.";
}

async function cmdNews(): Promise<string> {
  try {
    const news = await getTopNews(5);
    if (!news.length) return "📰 No news right now (RSS feed quiet).";
    return ["📰 TOP HEADLINES", "", ...news.map((n, i) => `${i + 1}. ${n.title}`)].join("\n");
  } catch (e) {
    return `📰 News fetch failed: ${e}`;
  }
}

async function cmdCalendar(): Promise<string> {
  try {
    const events = await getUpcomingEvents(24);
    if (!events.length) return "📅 Calendar's clear for the next 24 hours.";
    const lines = events.map((e) => {
      const t = e.start.toLocaleString("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });
      return `• ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
    });
    return ["📅 NEXT 24 HOURS", "", ...lines].join("\n");
  } catch (e) {
    return `📅 Calendar fetch failed: ${e}`;
  }
}

async function cmdUrgent(): Promise<string> {
  try {
    const emails = await getNewEmails(60); // last hour
    if (!emails.length) return "📭 No new emails in the last hour.";

    const alerts: string[] = [];
    for (const email of emails) {
      const scoreStr = await aiChat(
        `Rate urgency 1-10 for Dave (NYC steamfitter, IRS payoff focus, content creator). ONLY reply a number.\nFrom: ${email.sender}\nSubject: ${email.subject}\nPreview: ${email.snippet}`,
        15,
      );
      const score = parseInt(scoreStr.match(/\d+/)?.[0] ?? "0", 10);
      if (score >= 8) {
        const name = email.sender.split("<")[0].trim().replace(/"/g, "");
        alerts.push(`From: ${name} (${score}/10)\nSubject: ${email.subject}\nPreview: ${email.snippet.slice(0, 100)}`);
      }
    }

    if (!alerts.length) return `📭 Checked ${emails.length} email(s) from last hour — nothing urgent.`;
    return `🚨 ${alerts.length} URGENT in last hour:\n\n` + alerts.join("\n---\n");
  } catch (e) {
    return `🚨 Email scan failed: ${e}`;
  }
}

async function cmdVersion(): Promise<string> {
  return `Alfred ${VERSION} — code lives at /Users/sankore/Documents/Work/Claude Batcave/dave-assistant/`;
}

// ---------------------------------------------------------------------------
// Natural language — feed Dave's message to Gemini with full context.
// ---------------------------------------------------------------------------

async function naturalLanguage(message: string): Promise<string> {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  // Pull context in parallel so the reply is fast
  const [events, emails, news] = await Promise.all([
    safeCall(() => getUpcomingEvents(48), []),
    safeCall(() => getTodaysEmails(), []),
    safeCall(() => getTopNews(5), []),
  ]);

  const calendarBlock = events.length
    ? events
        .map((e) => {
          const t = e.start.toLocaleString("en-US", {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/New_York",
          });
          return `${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
        })
        .join("\n")
    : "(nothing on the calendar in the next 48h)";

  const emailBlock = emails.length
    ? emails.slice(0, 10).map((e) => `${e.sender.split("<")[0].trim()}: ${e.subject}`).join("\n")
    : "(no new emails today)";

  const newsBlock = news.length
    ? news.map((n, i) => `${i + 1}. ${n.title}`).join("\n")
    : "(no headlines fetched)";

  const prompt = `You are Alfred, Dave Douglas Jr.'s personal AI butler. Dave just texted you:

"${message}"

ABOUT DAVE (do not list this back to him unless directly relevant):
- 15-year journeyman steamfitter in NYC, HVAC background
- Building @dadailydougie trades influencer brand (bold/satirical jobsite content)
- Paying off ~$32k IRS debt — target Feb 2027 — every dollar matters
- davedouglasjr.com registered, single-page site built, hosting confirmation pending
- Style: bold, direct, no corporate fluff. Trades vibe.

CURRENT TIME: ${now} ET

DAVE'S CALENDAR (next 48h):
${calendarBlock}

DAVE'S RECENT EMAILS (today, top 10):
${emailBlock}

TOP NEWS HEADLINES TODAY:
${newsBlock}

INSTRUCTIONS:
- Reply in Dave's voice — direct, conversational, no preamble like "Here's your answer".
- Length matches the question. Short question → short answer. Open-ended → 2-4 sentences max.
- Use the context above if relevant. If Dave asks about something you don't have (weather, sports, news older than today, specific account balances), say so honestly and suggest what tool could be added.
- If Dave asks you to DO something (set a reminder, send an email, change a setting), say what you can/can't do yet. You currently CANNOT: send email on Dave's behalf, post to social media, modify the cron schedule, create new reminders. Tell him to "ask Claude" if it's a code change.
- Use plain text. No markdown asterisks/underscores. Telegram users won't see them as formatting.`;

  return aiChat(prompt, 1500);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireAndForget(url: string): void {
  // Don't await — let Telegram respond fast, the other function runs async
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  }).catch((e) => console.error("fireAndForget failed:", url, e));
}

async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error("context fetch failed:", e);
    return fallback;
  }
}

async function route(text: string): Promise<string> {
  const trimmed = text.trim();
  const lc = trimmed.toLowerCase();

  if (lc.startsWith("/start") || lc === "/help") return cmdStart();
  if (lc.startsWith("/status")) return cmdStatus();
  if (lc.startsWith("/briefing")) return cmdBriefing();
  if (lc.startsWith("/recap")) return cmdRecap();
  if (lc.startsWith("/news")) return cmdNews();
  if (lc.startsWith("/calendar")) return cmdCalendar();
  if (lc.startsWith("/urgent")) return cmdUrgent();
  if (lc.startsWith("/version")) return cmdVersion();

  // Unknown slash command — show help
  if (lc.startsWith("/")) {
    return `Unknown command "${trimmed.split(/\s+/)[0]}". Try /help for the list — or just text me normally and I'll try to answer.`;
  }

  // Plain text → natural language
  return naturalLanguage(trimmed);
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // Telegram only sends POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Validate webhook secret (Telegram sends it in this header)
  const headerSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!WEBHOOK_SECRET || headerSecret !== WEBHOOK_SECRET) {
    console.warn("telegram-webhook: rejected request (bad/missing secret token)");
    return new Response("Forbidden", { status: 403 });
  }

  let update: {
    message?: {
      chat?: { id: number };
      from?: { id: number; first_name?: string };
      text?: string;
      message_id?: number;
    };
  };
  try {
    update = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Telegram sends many update types; we only handle message text
  const message = update.message;
  if (!message?.text || !message.chat?.id) {
    // Acknowledge but do nothing for edits, photos, stickers, joins, etc.
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  // Reject anyone but Dave
  const chatId = String(message.chat.id);
  if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) {
    console.warn(`telegram-webhook: ignoring message from non-allowed chat ${chatId}`);
    // Don't reply — silent reject
    return new Response(JSON.stringify({ ok: true, unauthorized: true }), { status: 200 });
  }

  // Process
  try {
    const reply = await route(message.text);
    await sendTelegram(reply);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    console.error("telegram-webhook error:", e);
    try {
      await sendTelegram(`🦇 Sorry Dave — I hit an error: ${e}\n\n(Ask Claude to check the telegram-webhook logs.)`);
    } catch {}
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
