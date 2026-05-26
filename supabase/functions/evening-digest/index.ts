// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ evening-digest — 9 PM ET end-of-day pulse                             ║
// ║                                                                       ║
// ║ Mirrors morning brief but backward-looking. Today's captures,         ║
// ║ habit check, spending vs limits, tomorrow's calendar, journal nudge.  ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { notify } from "../_shared/notify.ts";
import { aiChat } from "../_shared/ai.ts";
import { logSMS } from "../_shared/db.ts";
import { getUpcomingEvents } from "../_shared/calendar.ts";
import { getIrsSnapshot, formatIrsLine, getSpendingStatus, formatSpendingBlock } from "../_shared/finance.ts";
import { getAllStreaks, formatHabitsBlock, getRecentCaptures, getOpenTodos } from "../_shared/capture.ts";
import { audit, recordHealth } from "../_shared/memory.ts";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { console.error("digest-context-fail:", e); return fallback; }
}

Deno.serve(async () => {
  const t0 = Date.now();
  try {
    const [irs, spending, habits, captures, openTodos, tomorrow] = await Promise.all([
      safe(() => getIrsSnapshot(), null),
      safe(() => getSpendingStatus(), []),
      safe(() => getAllStreaks(), []),
      safe(() => getRecentCaptures("all", 16), []),
      safe(() => getOpenTodos(), []),
      safe(() => getUpcomingEvents(36), []),
    ]);

    const todayStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

    // Pull just tomorrow's events (skip today's that already passed)
    const tomorrowEvents = tomorrow.filter((e) => {
      const ed = e.start.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
      const td = new Date(Date.now() + 86_400_000).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
      return ed === td;
    });

    const todayCaps = captures.filter((c) => {
      const cDate = new Date(c.created_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
      const tDate = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
      return cDate === tDate;
    });

    const captureCount = todayCaps.length;
    const todoDoneToday = todayCaps.filter((c) => c.kind === "todo" && c.done).length;
    const winsToday    = todayCaps.filter((c) => c.kind === "win").length;
    const ideasToday   = todayCaps.filter((c) => c.kind === "idea").length;

    const capturesBlock = todayCaps.length
      ? "📥 TODAY'S CAPTURES\n" + todayCaps.slice(0, 10).map((c) => `• [${c.kind}] ${c.body.slice(0, 80)}`).join("\n")
      : "";

    const openTodoBlock = openTodos.length
      ? "✅ OPEN TODOS (" + openTodos.length + ")\n" + openTodos.slice(0, 5).map((t, i) => `${i + 1}. ${t.body.slice(0, 70)}`).join("\n")
      : "";

    const tomorrowBlock = tomorrowEvents.length
      ? "🌅 TOMORROW\n" + tomorrowEvents.map((e) => {
          const t = e.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
          return `• ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
        }).join("\n")
      : "🌅 TOMORROW: clear calendar — make it count.";

    const habitsBlock = habits.length ? formatHabitsBlock(habits) : "";
    const spendBlock  = spending.length ? formatSpendingBlock(spending) : "";
    const irsLine     = irs ? formatIrsLine(irs) : "";

    // ── AI narrative: short, reflective, action-oriented ─────────────────────
    const prompt = `You are Alfred, Dave's butler. Write a SHORT evening digest for ${todayStr} (9 PM).

DAVE: Reno NV union pipefitter (13yr + 4yr supervision). DIVORCED, one daughter age 6, single income. #1 priority: IRS payoff (currently $${irs?.balance ?? "?"} left, ${irs?.daysToTarget ?? "?"} days to Feb 2027 target). Background tracks: CAD transition, Sunrun solar D2D, @dadailydougie content. Real creative lane: battle rap / freestyles / poetry / drones / tech comedy. ENFP, lone-wolf, strategic.

TODAY:
- Captures: ${captureCount} (${winsToday} wins, ${ideasToday} ideas, ${todoDoneToday} todos done)
- Open todos still pending: ${openTodos.length}
- Habits done today: ${habits.filter((h) => h.doneToday).length}/${habits.length}

WRITE EXACTLY THESE SECTIONS (plain text, blank lines between, no markdown):

🌙 EVENING CHECK-IN
2-3 sentences. Reflect on today's energy — productive? distracted? Acknowledge any wins captured. If light day, encourage rest. Tradesman tone.

🎯 TOMORROW'S #1
ONE thing Dave should do tomorrow. Default-anchor to IRS payoff progress unless something urgent is on calendar. Could also be a CAD portfolio piece, Sunrun door work, or content post. Specific and short.

✍️ JOURNAL PROMPT
ONE question for Dave to reflect on. Make it pointed — "What's the one thing you avoided today?" / "Where did money slip?" / "Best moment today?" Vary it. He can reply with /journal <answer> to save it.

🦇 GOODNIGHT
One short line. Alfred-flavored. Examples: "Rest sharp, Master Wayne. Cave's secure." / "Lights out. Tomorrow we work."

LENGTH: 600-1000 chars max — this is the wind-down, keep it lean.`;

    const narrative = await aiChat(prompt, 800);

    const headerBlocks = [
      `🌙 ALFRED — EVENING DIGEST, ${todayStr.toUpperCase()}`,
      irsLine,
      `📊 Today: ${captureCount} captures · ${winsToday}W · ${ideasToday} ideas`,
      capturesBlock,
      openTodoBlock,
      habitsBlock,
      spendBlock,
      tomorrowBlock,
    ].filter(Boolean).join("\n\n");

    const digest = `${headerBlocks}\n\n${"─".repeat(28)}\n\n${narrative}`;

    await notify(digest);
    await logSMS(digest, "evening_digest");
    await audit({ function_name: "evening-digest", action: "delivered", duration_ms: Date.now() - t0 });
    await recordHealth("evening-digest", true);

    return new Response(JSON.stringify({ ok: true, length: digest.length }), { status: 200 });
  } catch (e) {
    console.error("evening-digest error:", e);
    await recordHealth("evening-digest", false, String(e));
    await audit({ function_name: "evening-digest", action: "failed", status: "error", details: { error: String(e) } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
