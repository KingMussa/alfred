// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ weekly-review — Sunday 7 PM ET                                        ║
// ║                                                                       ║
// ║ Wide-lens look back: IRS progress vs roadmap, week's captures,        ║
// ║ habit streaks, spending vs limits, content ideas backlog, and a       ║
// ║ single named #1 priority for the coming week.                         ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { notify } from "../_shared/notify.ts";
import { aiChat } from "../_shared/ai.ts";
import { logSMS } from "../_shared/db.ts";
import { getIrsSnapshot, formatIrsLine, getSpendingStatus, formatSpendingBlock } from "../_shared/finance.ts";
import { getAllStreaks, formatHabitsBlock, getRecentCaptures, getOpenContentIdeas } from "../_shared/capture.ts";
import { audit, recordHealth } from "../_shared/memory.ts";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { console.error("weekly fail:", e); return fallback; }
}

Deno.serve(async () => {
  const t0 = Date.now();
  try {
    const [irs, spending, habits, captures, ideas] = await Promise.all([
      safe(() => getIrsSnapshot(), null),
      safe(() => getSpendingStatus(), []),
      safe(() => getAllStreaks(), []),
      safe(() => getRecentCaptures("all", 7 * 24), []),
      safe(() => getOpenContentIdeas(), []),
    ]);

    const wins   = captures.filter((c) => c.kind === "win");
    const ideasC = captures.filter((c) => c.kind === "idea");
    const todos  = captures.filter((c) => c.kind === "todo");
    const journals = captures.filter((c) => c.kind === "note" && c.body.length > 100);

    const irsLine = irs ? formatIrsLine(irs) : "";
    const habitsBlock = habits.length ? formatHabitsBlock(habits) : "";
    const spendBlock  = spending.length ? formatSpendingBlock(spending) : "";

    const winsBlock = wins.length
      ? "🏆 THIS WEEK'S WINS (" + wins.length + ")\n" + wins.slice(0, 6).map((w) => `• ${w.body.slice(0, 90)}`).join("\n")
      : "🏆 No wins captured this week — try /win next time something hits.";

    const ideasBlock = (ideasC.length || ideas.length)
      ? `💡 IDEAS BACKLOG\n• ${ideasC.length} this week · ${ideas.length} total open\n` +
        ideas.slice(0, 5).map((i) => `  - ${i.hook.slice(0, 70)}`).join("\n")
      : "";

    const prompt = `You are Alfred. Write a SHORT weekly review for Dave.

WEEKLY STATS:
- Captures: ${captures.length} total (${wins.length} wins, ${ideasC.length} ideas, ${todos.length} todos)
- Habit completion: ${habits.filter((h) => h.doneToday).length}/${habits.length} done today; top streak ${Math.max(0, ...habits.map((h) => h.streak))}d
- IRS: $${irs?.balance ?? "?"} left, ${irs?.daysToTarget ?? "?"} days to Feb 2027

WRITE EXACTLY THESE SECTIONS (plain text, no markdown, blank lines between):

📊 WEEK IN REVIEW
2-3 sentences. Was this a productive week? Reference capture count + habit consistency.

🎯 NEXT WEEK'S #1
ONE thing for Dave to commit to. Pick from: IRS payoff push, content posting cadence, davedouglasjr.com launch. Specific.

🚧 BIGGEST RISK
ONE risk that could derail next week. Could be a spending leak, a missed habit, a stale todo.

🦇 ALFRED'S NOTE
One short line from Alfred to Master Wayne. Encouraging, dry, not corny.

LENGTH: 700-1000 chars.`;

    const narrative = await aiChat(prompt, 800);

    const weekStart = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const weekEnd   = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const header = [
      `🦇 ALFRED — WEEKLY REVIEW`,
      `📆 ${weekStart} → ${weekEnd}`,
      irsLine,
      winsBlock,
      ideasBlock,
      habitsBlock,
      spendBlock,
    ].filter(Boolean).join("\n\n");

    const review = `${header}\n\n${"─".repeat(28)}\n\n${narrative}`;
    await notify(review);
    await logSMS(review, "weekly_review");
    await audit({ function_name: "weekly-review", action: "delivered", duration_ms: Date.now() - t0 });
    await recordHealth("weekly-review", true);

    return new Response(JSON.stringify({ ok: true, length: review.length }), { status: 200 });
  } catch (e) {
    console.error("weekly-review error:", e);
    await recordHealth("weekly-review", false, String(e));
    await audit({ function_name: "weekly-review", action: "failed", status: "error", details: { error: String(e) } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
