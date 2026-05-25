import { notify } from "../_shared/notify.ts";
import { getTodaysEmails } from "../_shared/gmail.ts";
import { getUpcomingEvents } from "../_shared/calendar.ts";
import { getTopNews } from "../_shared/news.ts";
import { aiChat } from "../_shared/ai.ts";
import { logSMS } from "../_shared/db.ts";

Deno.serve(async () => {
  try {
    const [news, events, emails] = await Promise.all([
      getTopNews(5),
      getUpcomingEvents(24),
      getTodaysEmails(),
    ]);

    const todayStr = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    });

    const newsBlock = news.length
      ? news.map((n, i) => `${i + 1}. ${n.title}`).join("\n")
      : "No news fetched.";

    const eventsBlock = events.length
      ? events
          .map((e) => {
            const t = e.start.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              timeZone: "America/New_York",
            });
            return `• ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
          })
          .join("\n")
      : "Nothing on the calendar today.";

    const emailBlock = emails.length
      ? emails
          .slice(0, 5)
          .map((e) => `• ${e.sender.split("<")[0].trim()}: ${e.subject}`)
          .join("\n")
      : "No new emails.";

    const prompt = `You are Alfred, Dave Douglas Jr.'s personal AI butler. Write a DETAILED, motivating morning briefing for ${todayStr}.

About Dave (context for personalization — do not list this back to him):
- 15-year journeyman steamfitter in NYC, HVAC background
- Building a trades-influencer brand at @dadailydougie (Instagram), goal is bold/satirical jobsite content
- Paying off ~$32k in IRS debt — target payoff Feb 2027 — every dollar counts
- Domain davedouglasjr.com registered, single-page site built, hosting confirmation pending
- Style: bold, dark, no corporate fluff. Trades vibe. Punchy and direct.

DATA TO DRAFT FROM
==================

TOP 5 NEWS HEADLINES:
${newsBlock}

TODAY'S CALENDAR (next 24h):
${eventsBlock}

RECENT EMAILS (last 24h):
${emailBlock}

WRITE THE BRIEFING IN THIS STRUCTURE
====================================

Use these EXACT section headers (with the emoji), separated by blank lines. Plain text only — no markdown bold/italic, no asterisks. This gets read on a phone screen.

☀️ GOOD MORNING DAVE
One paragraph, 2-3 sentences. Acknowledge the day (Monday grind vs Friday push vs weekend, etc.), comment on something timely. Be warm but not saccharine. Tradesman tone.

📰 NEWS DIGEST
For EACH of the 5 headlines, give the headline + ONE sentence of context explaining why it matters or what the implication is. Number them 1-5. Lean harder into NYC, economy, trades/construction, and tech-that-helps-trades stories. If a headline is fluff, give it one short line and move on.

📅 TODAY'S SCHEDULE
Walk through each calendar event in chronological order: time, what it is, where, and any prep tip if obvious (e.g. "leave 15 min early for traffic" or "bring the change order paperwork"). If the day is light or empty, say so and suggest 1-2 high-value uses of the time tied to Dave's goals (post a reel for @dadailydougie, push the davedouglasjr.com hosting question, etc.).

📩 EMAIL TRIAGE
Categorize the recent emails into these buckets, only including buckets that have entries:
  🚨 NEEDS RESPONSE — name + one-line subject summary
  💰 MONEY/INVOICE — anything financial (invoices owed, IRS notices, payment confirmations)
  📩 OPPORTUNITY — leads, brand deals, gigs, jobs
  🗑️ NOISE — count only, e.g. "12 promos/newsletters — ignore"

🎯 TODAY'S MOVE
Pick ONE thing — the single highest-leverage action Dave should focus on today. Tie it explicitly to either IRS payoff progress, influencer growth, or the website launch. Be decisive. 2-3 sentences.

🔧 CLOSER
One short line. Trade-flavored, no corporate cheese. Examples: "Tools sharp, head up. Let's go." / "Pipe don't lay itself. Move." / "Friday money's the best money." Vary it.

LENGTH: Aim for 1800-2400 characters total. Use blank lines between sections so it scans well on phone.`;

    const briefing = await aiChat(prompt, 2000);
    await notify(briefing);
    await logSMS(briefing, "morning_briefing");

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    console.error("morning-briefing error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
