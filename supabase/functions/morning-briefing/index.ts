// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ morning-briefing — Alfred's 6/7 AM daily intel drop                  ║
// ║                                                                       ║
// ║ Now includes IRS countdown, weather, bills due in 3 days, habit      ║
// ║ streaks, yesterday's captures, and the day's calendar + news + email. ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { notify } from "../_shared/notify.ts";
import { getTodaysEmails } from "../_shared/gmail.ts";
import { getUpcomingEvents } from "../_shared/calendar.ts";
import { getTopNews } from "../_shared/news.ts";
import { aiChat } from "../_shared/ai.ts";
import { logSMS } from "../_shared/db.ts";
import { getIrsSnapshot, formatIrsLine, getBillsDueSoon, getSpendingStatus, formatSpendingBlock } from "../_shared/finance.ts";
import { getTodayWeather, formatWeatherLine } from "../_shared/weather.ts";
import { getAllStreaks, formatHabitsBlock, getRecentCaptures } from "../_shared/capture.ts";
import { audited, audit, recordHealth } from "../_shared/memory.ts";
import { netWorthReport, formatNetWorthBlock } from "../_shared/wealth.ts";
import { dailyBudget, formatDailyBudgetBlock } from "../_shared/forecast.ts";
import { estimatedTaxReminder } from "../_shared/income.ts";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { console.error("brief-context-fail:", e); return fallback; }
}

Deno.serve(async () => {
  const t0 = Date.now();
  try {
    const [news, events, emails, irs, weather, bills, spending, habits, captures, netWorth, budget] = await Promise.all([
      safe(() => getTopNews(5), []),
      safe(() => getUpcomingEvents(24), []),
      safe(() => getTodaysEmails(), []),
      safe(() => getIrsSnapshot(), null),
      safe(() => getTodayWeather(), null),
      safe(() => getBillsDueSoon(7), []),
      safe(() => getSpendingStatus(), []),
      safe(() => getAllStreaks(), []),
      safe(() => getRecentCaptures("all", 18), []),
      safe(() => netWorthReport(), null),
      safe(() => dailyBudget(), null),
    ]);

    const todayStr = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    });

    const newsBlock = news.length
      ? news.map((n, i) => `${i + 1}. ${n.title}`).join("\n")
      : "No news fetched.";

    const eventsBlock = events.length
      ? events.map((e) => {
          const t = e.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
          return `• ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
        }).join("\n")
      : "Nothing on the calendar today.";

    const emailBlock = emails.length
      ? emails.slice(0, 5).map((e) => `• ${e.sender.split("<")[0].trim()}: ${e.subject}`).join("\n")
      : "No new emails.";

    // ── Deterministic data blocks (no AI for these) ──────────────────────────
    const irsLine     = irs ? formatIrsLine(irs) : "";
    const weatherLine = weather ? formatWeatherLine(weather) : "";
    const taxReminder = estimatedTaxReminder() ?? ""; // only within 10d of an estimated-tax date

    const billsLine = bills.length
      ? "📅 BILLS DUE\n" + bills.map(({ bill, daysOut, due }) => {
          const when = daysOut === 0 ? "TODAY" : daysOut === 1 ? "tomorrow" : `in ${daysOut}d (${due.toLocaleDateString("en-US",{month:"short",day:"numeric"})})`;
          const prio = bill.priority === 1 ? "🔴 " : "";
          return `${prio}${bill.name} $${bill.amount} — ${when}`;
        }).join("\n")
      : "";

    const habitsBlock = habits.length ? formatHabitsBlock(habits) : "";
    const spendBlock  = spending.length ? formatSpendingBlock(spending) : "";
    const netWorthBlock = netWorth ? formatNetWorthBlock(netWorth) : "";
    const cashBlock = budget ? formatDailyBudgetBlock(budget) : "";

    const yesterdayCaptures = captures.length
      ? "📥 SINCE YESTERDAY\n" + captures.slice(0, 8).map((c) => `• [${c.kind}] ${c.body.slice(0, 80)}`).join("\n")
      : "";

    // ── AI-generated narrative section ───────────────────────────────────────
    const prompt = `You are Alfred — Dave Douglas Jr.'s personal butler. Write the narrative sections of a morning briefing for ${todayStr}.

ABOUT DAVE (for tone — do not echo back):
- Reno, Nevada. Union pipefitter / steamfitter. 13 yrs + 4 yrs supervision. Home book Steamfitters Local 638 (NYC), traveling card UA Local 350 (Reno). Recent AutoCAD/Revit/BIM certs.
- DIVORCED. One daughter, age 6. Single-income household — every dollar matters.
- #1 PRIORITY: pay off $32k IRS debt by Feb 2027 (current balance $${irs?.balance ?? "?"}). Everything subordinates.
- Background tracks: CAD Technician career transition (Wilson Engineering type roles) · Solar D2D side hustle (Sunrun) · @dadailydougie trades content (long-game)
- Real creative lane: battle rap, freestyles, poetry, drones, tech comedy. These are the voice + content backbone — pair with his "information guy" persona.
- Personality: ENFP, high openness, lower conscientiousness, lone wolf. Likes Batman framing — Alfred occasionally calls him Master Wayne but sparingly.
- Voice: direct, blue-collar, no corporate fluff. Scripts and lists land better than paragraphs. Punchlines and wordplay welcome — he's a battle rap student.

DATA YOU CAN REFERENCE:

NEWS HEADLINES:
${newsBlock}

TODAY'S CALENDAR:
${eventsBlock}

RECENT EMAILS:
${emailBlock}

WEATHER: ${weather ? `${weather.conditions}, ${weather.tempLow}°-${weather.tempHigh}°F, rain ${weather.precipChance}%` : "n/a"}

WRITE EXACTLY THESE SECTIONS (use these exact headers with emoji, blank line between sections, no markdown bold/asterisks — plain text for phone):

☀️ GOOD MORNING DAVE
One paragraph, 2-3 sentences. Acknowledge the day (Monday vs Friday vs weekend energy), tie in weather if relevant. Warm but punchy.

📰 NEWS DIGEST
For each of the 5 headlines, give the headline + ONE sentence of context. Number them 1-5. Lean into Reno/Nevada, economy, trades/construction, data-center/Intel/TSMC builds, banking (spouse works in it), tech-that-helps-trades.

📅 TODAY'S SCHEDULE
Walk through each event chronologically with any prep tips. If day is light, suggest 1-2 high-leverage moves tied to Dave's goals: IRS payoff (#1), one CAD portfolio piece, knock 25 doors for Sunrun, post one piece to @dadailydougie, or finish a stalled davedouglasjr.com task.

📩 EMAIL TRIAGE
Categorize recent emails — only include buckets with entries:
  🚨 NEEDS RESPONSE — name + one-line summary
  💰 MONEY/INVOICE
  📩 OPPORTUNITY — leads/brand deals/gigs
  🗑️ NOISE — count only

🎯 TODAY'S MOVE
ONE highest-leverage action. Default-anchor to IRS payoff progress unless something more urgent is on calendar. Could also be a CAD application, a Sunrun door run, or a content post. Decisive. 2-3 sentences.

🔧 CLOSER
One short trade-flavored line. Vary it. Examples: "Tools sharp, head up." / "Pipe don't lay itself." / "Friday money's the best money."

LENGTH: 1600-2200 chars total. Blank lines between sections.`;

    const narrative = await aiChat(prompt, 2000);

    // ── Stitch deterministic blocks on top of the narrative ─────────────────
    const headerBlocks = [
      `🦇 ALFRED — ${todayStr.toUpperCase()}`,
      weatherLine,
      irsLine,
      taxReminder,
      netWorthBlock,
      cashBlock,
      billsLine,
      habitsBlock,
      spendBlock,
      yesterdayCaptures,
    ].filter(Boolean).join("\n\n");

    const briefing = `${headerBlocks}\n\n${"─".repeat(28)}\n\n${narrative}`;

    await notify(briefing);
    await logSMS(briefing, "morning_briefing");
    await audit({ function_name: "morning-briefing", action: "delivered", duration_ms: Date.now() - t0, details: { length: briefing.length } });
    await recordHealth("morning-briefing", true);

    return new Response(JSON.stringify({ ok: true, length: briefing.length }), { status: 200 });
  } catch (e) {
    console.error("morning-briefing error:", e);
    await recordHealth("morning-briefing", false, String(e));
    await audit({ function_name: "morning-briefing", action: "failed", status: "error", details: { error: String(e) } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
