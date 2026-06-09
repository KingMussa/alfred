/**
 * telegram-webhook — Alfred two-way + quick capture + financial intel.
 *
 * SLASH COMMANDS
 *   /help /status /version /quiet
 *
 *   ── Capture ──
 *   /note <text>       — save a quick note
 *   /idea <text>       — save a content idea (also added to content_ideas)
 *   /todo <text>       — open todo
 *   /done <id>         — mark todo id done
 *   /todos             — list open todos
 *   /win <text>        — record a win (used in weekly review)
 *   /jobsite <text>    — capture a jobsite observation/photo idea
 *   /quote <text>      — save a quote for content
 *
 *   ── Financial ──
 *   /expense <amt> <category> [note] — log an expense
 *   /irs               — IRS countdown + balance
 *   /pay <amt>         — record IRS payment, returns new balance
 *   /bills             — bills due within 7 days
 *   /spending          — spending vs limits this month
 *
 *   ── Habits ──
 *   /habits            — show habits + streaks
 *   /habit <name>      — log a habit done today (fuzzy match)
 *
 *   ── Journal ──
 *   /journal <text>    — save today's journal entry
 *   /journal mood:<1-10> <text> — with mood score
 *
 *   ── Briefings ──
 *   /briefing /recap /digest /news /calendar /urgent
 *
 *   ── Review (existing contact/iMessage cleanup) ──
 *   /review /skip /progress /execute
 *
 * PLAIN TEXT → Claude/Gemini with conversation memory + full context.
 */

import { aiChat } from "../_shared/ai.ts";
import { getNewEmails, getTodaysEmails } from "../_shared/gmail.ts";
import { getUpcomingEvents } from "../_shared/calendar.ts";
import { getTopNews } from "../_shared/news.ts";
import { sendTelegram } from "../_shared/telegram.ts";
import {
  saveCapture, getOpenTodos, completeTodo, getRecentCaptures,
  parseExpense, saveExpense,
  getHabits, logHabit, getAllStreaks, formatHabitsBlock,
  saveJournal, saveContentIdea,
} from "../_shared/capture.ts";
import {
  getIrsSnapshot, formatIrsLine, recordIrsPayment,
  getBillsDueSoon, getSpendingStatus, formatSpendingBlock,
} from "../_shared/finance.ts";
import { saveTurn, recentTurns, memoryBlock, audit, setPref, getPref } from "../_shared/memory.ts";
import {
  netWorthReport, formatNetWorthBlock,
  getAssets, getLiabilities, updateAssetBalance, updateLiabilityBalance,
  payoffReport, formatPayoffBlock,
  getGoals, upsertGoal, fundGoal, formatGoalsBlock,
} from "../_shared/wealth.ts";
import { buildForecast, formatForecastBlock, dailyBudget, formatDailyBudgetBlock } from "../_shared/forecast.ts";
import { getQuote, getQuotes, formatQuote, valuateHoldings, marketConfigured } from "../_shared/market.ts";
import { downloadTelegramFile, readDocument, actOnClassified, saveDocument } from "../_shared/vision.ts";
import { transcribeVoice, UNINTELLIGIBLE } from "../_shared/voice.ts";

const WEBHOOK_SECRET  = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ALLOWED_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const PROJECT_URL     = "https://rwhfueaclqcunnoraaix.supabase.co";
const ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ANON_KEY;
const VERSION         = "v3-robust (2026-05-26)";
const BATCH_SIZE      = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Supabase REST helpers (for the existing review queue logic — unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const SB = `${PROJECT_URL}/rest/v1`;
const headers = (extra: Record<string,string> = {}) => ({
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});
async function sbGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${SB}${path}`, { headers: headers() });
  if (!r.ok) throw new Error(`SB GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPatch(path: string, body: Record<string,unknown>): Promise<void> {
  const r = await fetch(`${SB}${path}`, {
    method: "PATCH", headers: headers({ "Prefer": "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`SB PATCH ${path}: ${r.status} ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Review queue (existing — left intact)
// ─────────────────────────────────────────────────────────────────────────────
interface QueueItem {
  id: number; type: string; name: string; subtitle: string;
  size_mb: number; msg_count: number; days_stale: number;
  is_protected: boolean; protection_reason: string | null;
  metadata: Record<string, unknown>;
}
async function getSession(): Promise<{ current_batch: number[]; mode: string }> {
  const rows = await sbGet("/review_session?id=eq.1") as Array<{ current_batch: number[]; mode: string }>;
  return rows[0] ?? { current_batch: [], mode: "all" };
}
async function setSession(patch: Record<string,unknown>): Promise<void> {
  await sbPatch("/review_session?id=eq.1", { ...patch, last_active: new Date().toISOString() });
}
async function getPendingBatch(mode: string): Promise<QueueItem[]> {
  let filter = "status=eq.pending&order=priority.desc,id.asc";
  if (mode === "imessage") filter += "&type=eq.imessage";
  if (mode === "contacts") filter += "&type=eq.contact";
  return await sbGet(`/review_queue?${filter}&limit=${BATCH_SIZE}`) as QueueItem[];
}
async function getPendingCounts(): Promise<Record<string,number>> {
  const all  = await sbGet("/review_queue?status=eq.pending&select=type") as Array<{type:string}>;
  const done = await sbGet("/review_queue?status=neq.pending&status=neq.skip&select=status") as Array<{status:string}>;
  return {
    contacts: all.filter(r => r.type === "contact").length,
    imessage: all.filter(r => r.type === "imessage").length,
    deleted:  done.filter(r => r.status === "delete" || r.status === "delete_attachments").length,
    kept:     done.filter(r => r.status === "keep").length,
    total_pending: all.length,
  };
}
function formatBatch(items: QueueItem[], mode: string): string {
  const lines: string[] = [];
  const typeLabel = mode === "imessage" ? "📱 iMESSAGE" : mode === "contacts" ? "👥 CONTACTS" : "📋 REVIEW";
  lines.push(`${typeLabel} BATCH — reply: d 1 3 / k 2 4 / d all / k all / skip`);
  lines.push("");
  items.forEach((item, i) => {
    const n = i + 1;
    const shield = item.is_protected ? " 🛡️" : "";
    const sizePart = item.size_mb > 0 ? ` 💾${item.size_mb.toFixed(0)}MB` : "";
    const typeIcon = item.type === "imessage" ? "💬" : "👤";
    lines.push(`${n}. ${typeIcon} ${item.name}${shield}`);
    lines.push(`   ${item.subtitle}${sizePart}`);
    if (item.is_protected) lines.push(`   ⚠️ ${item.protection_reason} — suggest keep`);
  });
  return lines.join("\n");
}
function parseDecisions(text: string, batchIds: number[]): Map<number, string> {
  const decisions = new Map<number, string>();
  const lc = text.toLowerCase().trim();
  if (/^(d|delete|del)\s+all/.test(lc)) { batchIds.forEach(id => decisions.set(id, "delete")); return decisions; }
  if (/^(k|keep)\s+all/.test(lc))       { batchIds.forEach(id => decisions.set(id, "keep")); return decisions; }
  if (/^(a|att|attachments?)\s+all/.test(lc)) { batchIds.forEach(id => decisions.set(id, "delete_attachments")); return decisions; }
  const segRe = /(d|k|a)\s+([\d\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = segRe.exec(lc)) !== null) {
    const action = m[1] === "d" ? "delete" : m[1] === "k" ? "keep" : "delete_attachments";
    const nums = m[2].trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= batchIds.length);
    nums.forEach(n => decisions.set(batchIds[n - 1], action));
  }
  const compactRe = /(\d+)(d|k|a)/gi;
  while ((m = compactRe.exec(lc)) !== null) {
    const n = parseInt(m[1]);
    if (n >= 1 && n <= batchIds.length) {
      const action = m[2] === "d" ? "delete" : m[2] === "k" ? "keep" : "delete_attachments";
      decisions.set(batchIds[n - 1], action);
    }
  }
  return decisions;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK CAPTURE handlers
// ─────────────────────────────────────────────────────────────────────────────
async function cmdNote(arg: string): Promise<string> {
  if (!arg) return "📝 Send `/note <text>` to save a note.";
  const r = await saveCapture("note", arg);
  return `📝 Note saved #${r.id}`;
}

async function cmdIdea(arg: string): Promise<string> {
  if (!arg) return "💡 Send `/idea <text>` for content ideas.\nTip: tag with #ig #tiktok #yt #reel";
  // Save both as capture + richer content_ideas row
  const r = await saveCapture("idea", arg);
  // Detect platform/format from tags
  const lc = arg.toLowerCase();
  const platform = lc.includes("#tiktok") ? "tiktok"
    : lc.includes("#yt") || lc.includes("#youtube") ? "youtube"
    : lc.includes("#ig") || lc.includes("#instagram") ? "instagram" : "any";
  const format = lc.includes("#reel") ? "reel"
    : lc.includes("#short") ? "short"
    : lc.includes("#carousel") ? "carousel" : "any";
  await saveContentIdea(arg.replace(/#\w+/g, "").trim(), platform, format);
  return `💡 Idea #${r.id} saved (${platform}/${format})`;
}

async function cmdTodo(arg: string): Promise<string> {
  if (!arg) return "✅ Send `/todo <text>` to add a todo.";
  const r = await saveCapture("todo", arg);
  return `✅ Todo #${r.id} added`;
}

async function cmdTodos(): Promise<string> {
  const todos = await getOpenTodos();
  if (!todos.length) return "✅ No open todos. Clean slate.";
  const head = `✅ OPEN TODOS (${todos.length})\nMark done with /done <id>`;
  const body = todos.slice(0, 15).map((t) => `${t.id}. ${t.body.slice(0, 80)}`).join("\n");
  return `${head}\n\n${body}`;
}

async function cmdDone(arg: string): Promise<string> {
  const id = parseInt(arg.trim(), 10);
  if (!Number.isFinite(id)) return "Usage: /done <id> — find ids via /todos";
  await completeTodo(id);
  return `✅ Done — todo #${id} closed`;
}

async function cmdWin(arg: string): Promise<string> {
  if (!arg) return "🏆 Send `/win <what you crushed>`";
  const r = await saveCapture("win", arg);
  return `🏆 Win logged #${r.id} — see you in Sunday's review.`;
}

async function cmdJobsite(arg: string): Promise<string> {
  if (!arg) return "🔧 Send `/jobsite <what you saw>` — material for content + war stories.";
  const r = await saveCapture("jobsite", arg);
  return `🔧 Jobsite log #${r.id} saved`;
}

async function cmdLine(arg: string): Promise<string> {
  if (!arg) return "💬 Send `/line <text>` — save a punchline / bar / quote for content.";
  const r = await saveCapture("quote", arg);
  return `💬 Line saved #${r.id}`;
}

async function cmdCaptures(): Promise<string> {
  const rows = await getRecentCaptures("all", 48);
  if (!rows.length) return "📥 No captures in the last 48h.";
  return "📥 LAST 48H CAPTURES\n\n" +
    rows.slice(0, 15).map((c) => `[${c.kind}] ${c.body.slice(0, 90)}`).join("\n");
}

async function cmdBlueprints(): Promise<string> {
  const rows = await sbGet(
    "/documents?doc_type=eq.blueprint&order=created_at.desc&limit=10&select=id,summary,extracted_data,created_at",
  ) as Array<{ id: number; summary?: string; extracted_data?: Record<string, unknown>; created_at?: string }>;
  if (!rows.length) return "📐 No blueprints captured yet. Snap a pic of a drawing and I'll read it.";
  const lines = rows.map((r) => {
    const d = (r.extracted_data ?? {}) as { sheet_number?: string; title?: string; revision?: string };
    const tag = [d.sheet_number, d.revision ? `Rev ${d.revision}` : ""].filter(Boolean).join(" ");
    const label = tag || d.title || r.summary || "blueprint";
    const date = r.created_at?.slice(0, 10) ?? "";
    return `#${r.id} ${label}${date ? ` · ${date}` : ""}`;
  });
  return "📐 BLUEPRINTS (recent)\n\n" + lines.join("\n") + "\n\nSnap another drawing anytime — I'll read + save it.";
}

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL handlers
// ─────────────────────────────────────────────────────────────────────────────
async function cmdExpense(arg: string): Promise<string> {
  const parsed = parseExpense(arg);
  if (!parsed) return "💸 Usage: /expense <amount> <category> [note]\nCategories: atm dining casino amazon gas groceries apple_cash subscription gear\nEx: /expense 75 atm pulled cash for the weekend";
  await saveExpense(parsed);
  // After saving, return spending status for that category
  const status = await getSpendingStatus();
  const row = status.find((s) => s.category === parsed.category);
  let line = `💸 Logged $${parsed.amount} → ${parsed.category}`;
  if (row) {
    const icon = row.over ? "🔴 OVER LIMIT" : row.pct >= 80 ? "🟠 close" : row.pct >= 60 ? "🟡 watch" : "✅";
    line += `\n${icon} ${parsed.category}: $${row.spent_this_month}/$${row.monthly_cap} this month (${row.pct}%)`;
  }
  return line;
}

async function cmdIrs(): Promise<string> {
  const s = await getIrsSnapshot();
  return [
    formatIrsLine(s),
    "",
    `Paid to date: $${s.paid.toLocaleString()}`,
    `Progress: ${s.progressPct}% to zero`,
    `Months left: ${s.monthsToTarget}`,
    s.onTrack
      ? "Pace OK at $3k/mo — stay locked in."
      : `Need $${s.monthlyPaceRequired.toLocaleString()}/mo to hit Feb '27. Push harder or extend.`,
  ].join("\n");
}

async function cmdPay(arg: string): Promise<string> {
  const m = arg.match(/(\d+(?:\.\d+)?)/);
  if (!m) return "Usage: /pay <amount> — example: /pay 3000";
  const amount = parseFloat(m[1]);
  const after = await recordIrsPayment(amount, "Logged via Telegram");
  return `💸 $${amount.toLocaleString()} applied to IRS.\n\n${formatIrsLine(after)}\n${after.progressPct}% to zero · ${after.daysToTarget}d to Feb '27`;
}

async function cmdBills(): Promise<string> {
  const upcoming = await getBillsDueSoon(14);
  if (!upcoming.length) return "📅 No bills due in the next 14 days.";
  return "📅 BILLS DUE (14d)\n\n" + upcoming.map(({ bill, daysOut, due }) => {
    const when = daysOut === 0 ? "TODAY" : daysOut === 1 ? "tomorrow" : `in ${daysOut}d (${due.toLocaleDateString("en-US",{month:"short",day:"numeric"})})`;
    const prio = bill.priority === 1 ? "🔴 " : "💸 ";
    return `${prio}${bill.name} $${bill.amount} — ${when}${bill.paid_from ? ` (${bill.paid_from})` : ""}`;
  }).join("\n");
}

async function cmdSpending(): Promise<string> {
  const rows = await getSpendingStatus();
  return formatSpendingBlock(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// HABIT handlers
// ─────────────────────────────────────────────────────────────────────────────
async function cmdHabits(): Promise<string> {
  const rows = await getAllStreaks();
  if (!rows.length) return "🏆 No habits set up. Ask Claude on your laptop to add some.";
  return formatHabitsBlock(rows) + "\n\nMark done: /habit <name>";
}

async function cmdHabit(arg: string): Promise<string> {
  if (!arg) return "Usage: /habit <name>  (fuzzy match)\nList with /habits";
  const habits = await getHabits();
  const q = arg.toLowerCase().trim();
  const match = habits.find((h) => h.name.toLowerCase().includes(q));
  if (!match) return `❓ No habit matching "${arg}". List: /habits`;
  await logHabit(match.id, true);
  return `${match.emoji ?? "✅"} ${match.name} — logged for today.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL
// ─────────────────────────────────────────────────────────────────────────────
async function cmdJournal(arg: string): Promise<string> {
  if (!arg) return "Usage: /journal <text>\nOptional mood: /journal mood:7 today was solid";
  const moodMatch = arg.match(/mood:(\d+)/i);
  const mood = moodMatch ? parseInt(moodMatch[1], 10) : undefined;
  const body = arg.replace(/mood:\d+/i, "").trim();
  await saveJournal(body, mood);
  return `📓 Journal saved${mood ? ` (mood ${mood}/10)` : ""}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUIET HOURS
// ─────────────────────────────────────────────────────────────────────────────
async function cmdQuiet(arg: string): Promise<string> {
  if (!arg) {
    const pref = await getPref<{ start: string; end: string }>("quiet_hours");
    return pref ? `🤫 Quiet hours: ${pref.start} – ${pref.end} ET` : "🤫 No quiet hours set.";
  }
  // Accept "22:00-06:30" or "off"
  if (arg.trim().toLowerCase() === "off") {
    await setPref("quiet_hours", { start: "00:00", end: "00:00", tz: "America/Los_Angeles" });
    return "🤫 Quiet hours disabled.";
  }
  const m = arg.match(/(\d{1,2}:\d{2})\s*[-→]\s*(\d{1,2}:\d{2})/);
  if (!m) return "Usage: /quiet 22:00-06:30  or  /quiet off";
  await setPref("quiet_hours", { start: m[1], end: m[2], tz: "America/Los_Angeles" });
  return `🤫 Quiet hours set ${m[1]} – ${m[2]} ET.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// v4 — NET WORTH / DEBT PAYOFF / GOALS
// ─────────────────────────────────────────────────────────────────────────────
async function cmdNet(): Promise<string> {
  const r = await netWorthReport();
  return formatNetWorthBlock(r);
}

async function cmdPayoff(): Promise<string> {
  const plans = await payoffReport();
  return formatPayoffBlock(plans);
}

async function cmdAssets(): Promise<string> {
  const rows = await getAssets();
  if (!rows.length) return "🏦 No assets tracked.";
  const lines = ["🏦 ASSETS"];
  for (const a of rows) {
    lines.push(`${a.name} (${a.account_type}) — $${Number(a.balance).toLocaleString()}`);
  }
  lines.push(``, `Update: /asset <id> <new_balance>`);
  lines.push(`List IDs: /asset list`);
  return lines.join("\n");
}

async function cmdAsset(arg: string): Promise<string> {
  if (arg === "list" || !arg) {
    const rows = await getAssets();
    return rows.map((a) => `${a.id}. ${a.name} ($${Number(a.balance).toLocaleString()})`).join("\n");
  }
  const m = arg.match(/(\d+)\s+\$?(\d+(?:\.\d+)?)/);
  if (!m) return "Usage: /asset <id> <new_balance>  (find id via /asset list)";
  await updateAssetBalance(parseInt(m[1], 10), parseFloat(m[2]));
  return `✅ Updated asset #${m[1]} to $${m[2]}`;
}

async function cmdDebts(): Promise<string> {
  const rows = await getLiabilities();
  if (!rows.length) return "✅ No debts. Clean.";
  const lines = ["💸 LIABILITIES"];
  for (const l of rows) {
    const apr = l.interest_rate ? ` @ ${Number(l.interest_rate).toFixed(1)}%` : "";
    const pmt = l.min_payment ? ` (min $${l.min_payment}/mo)` : "";
    lines.push(`${l.id}. ${l.name} — $${Number(l.balance).toLocaleString()}${apr}${pmt}`);
  }
  lines.push(``, `Update: /debt <id> <new_balance>`);
  return lines.join("\n");
}

async function cmdDebt(arg: string): Promise<string> {
  const m = arg.match(/(\d+)\s+\$?(\d+(?:\.\d+)?)/);
  if (!m) return "Usage: /debt <id> <new_balance>  (find id via /debts)";
  await updateLiabilityBalance(parseInt(m[1], 10), parseFloat(m[2]));
  return `✅ Updated debt #${m[1]} to $${m[2]}`;
}

async function cmdGoals(): Promise<string> {
  const goals = await getGoals();
  return formatGoalsBlock(goals);
}

async function cmdGoal(arg: string): Promise<string> {
  // Three modes:
  //   /goal <name> $<target> [by YYYY-MM-DD]    → create/update goal
  //   /goal fund <name> $<amount>               → add to bucket
  if (!arg) return "Usage:\n/goal <name> $<target> [by YYYY-MM-DD]\n/goal fund <name> $<amount>";

  const fundMatch = arg.match(/^fund\s+(.+?)\s+\$?(\d+(?:\.\d+)?)/i);
  if (fundMatch) {
    const g = await fundGoal(fundMatch[1].trim(), parseFloat(fundMatch[2]));
    if (!g) return `❓ No goal "${fundMatch[1]}". /goals to list.`;
    const pct = Math.round((g.current_amount / g.target_amount) * 100);
    return `🎯 ${g.name}: $${Number(g.current_amount).toLocaleString()} / $${Number(g.target_amount).toLocaleString()} (${pct}%)`;
  }

  const m = arg.match(/^(.+?)\s+\$?(\d+(?:\.\d+)?)(?:\s+by\s+(\d{4}-\d{2}-\d{2}))?/);
  if (!m) return "Usage: /goal <name> $<target> [by YYYY-MM-DD]";
  await upsertGoal(m[1].trim(), parseFloat(m[2]), m[3]);
  return `🎯 Goal "${m[1].trim()}" → $${m[2]}${m[3] ? ` by ${m[3]}` : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// v4 — CASH FLOW FORECAST
// ─────────────────────────────────────────────────────────────────────────────
async function cmdCash(): Promise<string> {
  const b = await dailyBudget();
  return formatDailyBudgetBlock(b);
}

async function cmdForecast(): Promise<string> {
  const assets = await getAssets();
  const startingBalance = assets
    .filter((a) => ["checking", "savings", "mmsa"].includes(a.account_type))
    .reduce((s, a) => s + Number(a.balance), 0);
  const r = await buildForecast(startingBalance);
  return formatForecastBlock(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// v4 — INVESTMENTS / PORTFOLIO
// ─────────────────────────────────────────────────────────────────────────────
async function cmdStockQuote(arg: string): Promise<string> {
  if (!arg) return "Usage: /quote <symbol>   ex: /quote AAPL";
  if (!marketConfigured()) {
    return "🚫 Live quotes off.\nAdd FMP_API_KEY to Supabase secrets:\n1. Get free key at financialmodelingprep.com (250/day)\n2. `supabase secrets set FMP_API_KEY=...` from the dave-assistant repo\n3. Redeploy telegram-webhook";
  }
  const q = await getQuote(arg);
  if (!q) return `❓ No quote for "${arg}"`;
  return formatQuote(q);
}

async function cmdPortfolio(): Promise<string> {
  const rows = await sbGet("/holdings?active=eq.true&order=symbol.asc&select=*") as Array<{
    id: number; symbol: string; qty: number; cost_basis: number; account: string; asset_class: string;
  }>;
  if (!rows.length) return "📊 No holdings. Log one with:\n/buy <symbol> <qty> @ <price>\nex: /buy AAPL 10 @175";

  if (!marketConfigured()) {
    // Show cost basis only
    const lines = ["📊 PORTFOLIO (cost basis only — add FMP_API_KEY for live)"];
    let totalCost = 0;
    for (const h of rows) {
      const avg = Number(h.cost_basis) / Number(h.qty);
      lines.push(`${h.symbol}  ${Number(h.qty)} sh · avg $${avg.toFixed(2)} · cost $${Number(h.cost_basis).toLocaleString()}`);
      totalCost += Number(h.cost_basis);
    }
    lines.push(``, `Total cost: $${totalCost.toLocaleString()}`);
    return lines.join("\n");
  }

  const valued = await valuateHoldings(rows);
  let totalValue = 0, totalCost = 0;
  const lines = ["📊 PORTFOLIO"];
  for (const h of valued) {
    totalCost += Number(h.cost_basis);
    totalValue += h.currentValue ?? Number(h.cost_basis);
    if (h.currentValue === null) {
      lines.push(`${h.symbol} ${h.qty} sh · cost $${Number(h.cost_basis).toLocaleString()} · no quote`);
      continue;
    }
    const arrow = (h.pnlPct ?? 0) >= 0 ? "▲" : "▼";
    lines.push(`${arrow} ${h.symbol}  ${Number(h.qty)} sh · $${h.currentPrice?.toFixed(2)}`);
    lines.push(`   Value $${h.currentValue.toLocaleString()} · P&L ${h.pnl! >= 0 ? "+" : ""}$${h.pnl!.toLocaleString()} (${h.pnlPct!.toFixed(1)}%)`);
  }
  const totalPnl = totalValue - totalCost;
  const totalPct = totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(1) : "0.0";
  lines.push(``, `TOTAL: $${totalValue.toLocaleString()} · cost $${totalCost.toLocaleString()} · P&L ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toLocaleString()} (${totalPct}%)`);
  return lines.join("\n");
}

async function cmdBuy(arg: string): Promise<string> {
  // /buy AAPL 10 @175  or  /buy AAPL 10 175
  const m = arg.match(/^(\S+)\s+(\d+(?:\.\d+)?)\s+@?\s*\$?(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
  if (!m) return "Usage: /buy <symbol> <qty> @<price> [account]\nex: /buy AAPL 10 @175";
  const [, sym, qtyStr, priceStr, acct] = m;
  const qty = parseFloat(qtyStr);
  const price = parseFloat(priceStr);
  const cost = +(qty * price).toFixed(2);
  const account = acct?.trim() || "Robinhood";

  // Log trade + update holding (consolidate if symbol already exists)
  await fetch(`${URL_TG}/rest/v1/trades`, {
    method: "POST",
    headers: { ...HDRS_TG, Prefer: "return=minimal" },
    body: JSON.stringify({ symbol: sym.toUpperCase(), side: "buy", qty, price, account }),
  });

  const existingR = await fetch(`${URL_TG}/rest/v1/holdings?symbol=eq.${sym.toUpperCase()}&account=eq.${encodeURIComponent(account)}&active=eq.true&select=*`, { headers: HDRS_TG });
  const existing = (await existingR.json()) as Array<{ id: number; qty: number; cost_basis: number }>;
  if (existing.length) {
    const newQty = Number(existing[0].qty) + qty;
    const newCost = Number(existing[0].cost_basis) + cost;
    await fetch(`${URL_TG}/rest/v1/holdings?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { ...HDRS_TG, Prefer: "return=minimal" },
      body: JSON.stringify({ qty: newQty, cost_basis: newCost }),
    });
    return `📈 BUY ${qty} ${sym.toUpperCase()} @ $${price} — added to existing position. New: ${newQty} sh, avg $${(newCost/newQty).toFixed(2)}`;
  } else {
    await fetch(`${URL_TG}/rest/v1/holdings`, {
      method: "POST",
      headers: { ...HDRS_TG, Prefer: "return=minimal" },
      body: JSON.stringify({ symbol: sym.toUpperCase(), qty, cost_basis: cost, account }),
    });
    return `📈 BUY ${qty} ${sym.toUpperCase()} @ $${price} ($${cost.toLocaleString()}) in ${account}`;
  }
}

async function cmdSell(arg: string): Promise<string> {
  // /sell AAPL 5 @180
  const m = arg.match(/^(\S+)\s+(\d+(?:\.\d+)?)\s+@?\s*\$?(\d+(?:\.\d+)?)/);
  if (!m) return "Usage: /sell <symbol> <qty> @<price>\nex: /sell AAPL 5 @180";
  const [, sym, qtyStr, priceStr] = m;
  const qty = parseFloat(qtyStr);
  const price = parseFloat(priceStr);

  await fetch(`${URL_TG}/rest/v1/trades`, {
    method: "POST",
    headers: { ...HDRS_TG, Prefer: "return=minimal" },
    body: JSON.stringify({ symbol: sym.toUpperCase(), side: "sell", qty, price }),
  });

  const existingR = await fetch(`${URL_TG}/rest/v1/holdings?symbol=eq.${sym.toUpperCase()}&active=eq.true&select=*`, { headers: HDRS_TG });
  const existing = (await existingR.json()) as Array<{ id: number; qty: number; cost_basis: number }>;
  if (!existing.length) return `❓ No active position in ${sym.toUpperCase()}`;

  const newQty = Number(existing[0].qty) - qty;
  if (newQty <= 0.0001) {
    // Close it out
    await fetch(`${URL_TG}/rest/v1/holdings?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { ...HDRS_TG, Prefer: "return=minimal" },
      body: JSON.stringify({ active: false, closed_at: new Date().toISOString() }),
    });
    const proceeds = qty * price;
    const pnl = proceeds - Number(existing[0].cost_basis);
    return `📉 SELL ${qty} ${sym.toUpperCase()} @ $${price} — POSITION CLOSED. P&L ${pnl >= 0 ? "+" : ""}$${pnl.toLocaleString()}`;
  } else {
    // Reduce qty proportionally; cost basis scales down
    const newCost = +(Number(existing[0].cost_basis) * (newQty / Number(existing[0].qty))).toFixed(2);
    await fetch(`${URL_TG}/rest/v1/holdings?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { ...HDRS_TG, Prefer: "return=minimal" },
      body: JSON.stringify({ qty: newQty, cost_basis: newCost }),
    });
    return `📉 SELL ${qty} ${sym.toUpperCase()} @ $${price}. Position: ${newQty} sh remaining, cost $${newCost.toLocaleString()}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v4 — DECISION LOG
// ─────────────────────────────────────────────────────────────────────────────
async function cmdLogDecision(arg: string): Promise<string> {
  // /decide <decision> :: <rationale> :: <expected outcome>
  if (!arg) return "Usage: /decide <decision> :: <rationale> :: <expected outcome>\nex: /decide Apply $1k extra to IRS :: Cuts payoff by 2 weeks :: Less interest, locked feeling";
  const parts = arg.split("::").map((s) => s.trim());
  const [decision, rationale, expected] = [parts[0], parts[1] ?? null, parts[2] ?? null];
  if (!decision) return "Need a decision before the ::";
  const reviewDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const r = await fetch(`${URL_TG}/rest/v1/decisions`, {
    method: "POST",
    headers: { ...HDRS_TG, Prefer: "return=representation" },
    body: JSON.stringify({
      decision, rationale, expected_outcome: expected,
      review_date: reviewDate,
      category: null,
    }),
  });
  const rows = (await r.json()) as Array<{ id: number }>;
  return `🧠 Decision #${rows[0]?.id} logged. Review in 30d (${reviewDate}).`;
}

async function cmdDecisions(): Promise<string> {
  const r = await fetch(`${URL_TG}/rest/v1/decisions?order=decided_at.desc&limit=10&select=*`, { headers: HDRS_TG });
  const rows = (await r.json()) as Array<{
    id: number; decision: string; rationale: string | null; reviewed: boolean; decided_at: string;
  }>;
  if (!rows.length) return "🧠 No decisions logged yet. /decide to start.";
  const lines = ["🧠 RECENT DECISIONS"];
  for (const d of rows) {
    const flag = d.reviewed ? "✅" : "⏳";
    const date = new Date(d.decided_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    lines.push(`${flag} #${d.id} (${date}) ${d.decision.slice(0, 80)}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// v4 — AI MONTHLY ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────
async function cmdAnalyze(): Promise<string> {
  // Aggregate: net worth, spending YTD, IRS pace, captures, habits, decisions
  const [nw, irs, spending, payoffs, goals] = await Promise.all([
    netWorthReport(),
    getIrsSnapshot(),
    getSpendingStatus(),
    payoffReport(),
    getGoals(),
  ]);

  const prompt = `You are Alfred. Dave just asked /analyze. Write a SHORT (under 800 chars) financial diagnostic.

NUMBERS:
- Net worth: $${nw.current.net_worth.toLocaleString()} (assets $${nw.current.assets_total.toLocaleString()}, debts $${nw.current.liabilities_total.toLocaleString()})
- 30-day delta: ${nw.delta30 !== null ? "$" + nw.delta30.toLocaleString() : "no data"}
- IRS: $${irs.balance.toLocaleString()} left, ${irs.daysToTarget}d to Feb 2027, $${irs.monthlyPaceRequired}/mo pace required, ${irs.onTrack ? "ON TRACK" : "BEHIND"}
- Top spending leaks (over 60%): ${spending.filter((s) => s.pct >= 60).map((s) => `${s.category} ${s.pct}%`).join(", ") || "none"}
- Goals: ${goals.map((g) => `${g.name} ${Math.round((g.current_amount/g.target_amount)*100)}%`).join(" · ") || "none set"}

WRITE EXACTLY:
1. ONE sentence diagnosis ("here's where you stand")
2. ONE biggest leak or risk
3. ONE specific move this week (dollar amount + action)
4. ONE short line of encouragement (Alfred-flavored)

Plain text, no markdown.`;

  const r = await aiChat(prompt, 800);
  return `📈 ALFRED'S READ\n\n${r}`;
}

// Shared local refs so handlers can call REST directly
const URL_TG     = "https://rwhfueaclqcunnoraaix.supabase.co";
const HDRS_TG    = headers();

// ─────────────────────────────────────────────────────────────────────────────
// BRIEFING TRIGGERS + existing slash commands
// ─────────────────────────────────────────────────────────────────────────────
async function cmdStart(): Promise<string> {
  return [
    "🦇 Alfred at your service, Master Wayne.",
    "",
    "QUICK CAPTURE",
    "  /note · /idea · /todo · /done · /todos",
    "  /win · /jobsite · /line · /captures",
    "  (/line = save a punchline/bar for content)",
    "",
    "FINANCIAL — DAY-TO-DAY",
    "  /irs · /pay <amt> · /bills · /spending",
    "  /expense <amt> <cat> [note]",
    "  /cash      — today's safe-to-spend",
    "  /forecast  — 90-day cash flow",
    "",
    "FINANCIAL — WEALTH MODELING (NEW)",
    "  /net       — net worth + 7d/30d delta",
    "  /assets · /asset <id> <bal>",
    "  /debts · /debt <id> <bal>",
    "  /payoff    — debt payoff projection",
    "  /goals · /goal <name> $<amt> by <date>",
    "  /goal fund <name> $<amt>",
    "",
    "INVESTMENTS (NEW)",
    "  /quote <symbol>           — live price (FMP)",
    "  /portfolio                — holdings + P&L",
    "  /buy <sym> <qty> @<price> — log a buy",
    "  /sell <sym> <qty> @<price>",
    "",
    "DECISIONS (NEW)",
    "  /decide <what> :: <why> :: <expected outcome>",
    "  /decisions                — last 10",
    "",
    "ANALYSIS",
    "  /analyze   — Alfred's monthly read",
    "",
    "HABITS & JOURNAL",
    "  /habits · /habit · /journal [mood:N] <text>",
    "",
    "BRIEFINGS",
    "  /briefing · /digest · /recap",
    "  /news · /calendar · /urgent",
    "",
    "REVIEW QUEUE",
    "  /review · /skip · /progress · /execute",
    "",
    "SYSTEM",
    "  /status · /version · /quiet 22:00-06:30",
    "",
    "📸 SNAP A PHOTO (NEW)",
    "  Receipt → auto-logged as expense",
    "  Bank statement → balance extracted",
    "  Credit card statement → debt + spending",
    "  Paystub → income detected",
    "  IRS letter → flagged + todo created",
    "  (works with photos OR PDFs attached as documents)",
    "",
    "Or just talk to me — I remember the last two weeks of our chats.",
  ].join("\n");
}

async function cmdStatus(): Promise<string> {
  const irs = await getIrsSnapshot().catch(() => null);
  const counts = await getPendingCounts().catch(() => ({ total_pending: "?" }));
  return [
    "📊 ALFRED STATUS",
    `Now: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} ET`,
    `Version: ${VERSION}`,
    "",
    irs ? formatIrsLine(irs) : "",
    "",
    "Schedule:",
    "  • Morning briefing — 7 AM ET",
    "  • Evening digest — 9 PM ET",
    "  • Bill reminders — 8 AM ET (3d/1d/day-of)",
    "  • Calendar reminders — every 15 min",
    "  • Email recap — 6 PM ET",
    "  • Weekly review — Sun 7 PM ET",
    "  • Health check — hourly",
    "",
    `Review queue: ${counts.total_pending} items pending`,
    "AI: Claude Haiku (primary) · Gemini fallback",
  ].filter((l) => l !== null).join("\n");
}

async function cmdBriefing(): Promise<string> {
  fireAndForget(`${PROJECT_URL}/functions/v1/morning-briefing`);
  return "🌅 Firing morning briefing — arriving shortly.";
}
async function cmdDigest(): Promise<string> {
  fireAndForget(`${PROJECT_URL}/functions/v1/evening-digest`);
  return "🌙 Firing evening digest — arriving shortly.";
}
async function cmdRecap(): Promise<string> {
  fireAndForget(`${PROJECT_URL}/functions/v1/email-checker`);
  return "📬 Firing evening recap — checking last 12h.";
}
async function cmdNews(): Promise<string> {
  try {
    const news = await getTopNews(5);
    if (!news.length) return "📰 No news right now.";
    return ["📰 TOP HEADLINES", "", ...news.map((n, i) => `${i + 1}. ${n.title}`)].join("\n");
  } catch (e) { return `📰 News fetch failed: ${e}`; }
}
async function cmdCalendar(): Promise<string> {
  try {
    const events = await getUpcomingEvents(24);
    if (!events.length) return "📅 Clear for the next 24 hours.";
    return ["📅 NEXT 24 HOURS", "", ...events.map(e => {
      const t = e.start.toLocaleString("en-US", { weekday:"short", hour:"numeric", minute:"2-digit", timeZone:"America/Los_Angeles" });
      return `• ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
    })].join("\n");
  } catch (e) { return `📅 Calendar fetch failed: ${e}`; }
}
async function cmdUrgent(): Promise<string> {
  try {
    const emails = await getNewEmails(60);
    if (!emails.length) return "📭 No new emails in the last hour.";
    const alerts: string[] = [];
    for (const email of emails) {
      const scoreStr = await aiChat(
        `Rate urgency 1-10 for Dave (NYC steamfitter, IRS payoff focus). ONLY reply a number.\nFrom: ${email.sender}\nSubject: ${email.subject}\nPreview: ${email.snippet}`, 15);
      const score = parseInt(scoreStr.match(/\d+/)?.[0] ?? "0", 10);
      if (score >= 8) {
        const name = email.sender.split("<")[0].trim().replace(/"/g, "");
        alerts.push(`From: ${name} (${score}/10)\n${email.subject}\n${email.snippet.slice(0, 100)}`);
      }
    }
    if (!alerts.length) return `📭 Checked ${emails.length} email(s) — nothing urgent.`;
    return `🚨 ${alerts.length} URGENT:\n\n` + alerts.join("\n---\n");
  } catch (e) { return `🚨 Email scan failed: ${e}`; }
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW commands (existing)
// ─────────────────────────────────────────────────────────────────────────────
async function cmdReview(arg: string): Promise<string> {
  const mode = ["imessage","contacts","all"].includes(arg) ? arg : "all";
  const batch = await getPendingBatch(mode);
  if (!batch.length) return `✅ Nothing left to review${mode !== "all" ? ` in ${mode}` : ""}! Type /progress for totals.`;
  await setSession({ current_batch: batch.map(i => i.id), mode });
  const counts = await getPendingCounts();
  const header = `📊 ${counts.total_pending} pending (${counts.contacts} contacts · ${counts.imessage} iMsg)\n`;
  return header + formatBatch(batch, mode);
}
async function cmdDecide(text: string): Promise<string | null> {
  const session = await getSession();
  if (!session.current_batch?.length) return null;
  const decisions = parseDecisions(text, session.current_batch);
  if (!decisions.size) return null;
  const now = new Date().toISOString();
  const results: string[] = [];
  for (const [id, status] of decisions) {
    await sbPatch(`/review_queue?id=eq.${id}`, { status, decided_at: now });
    results.push(status === "delete" ? "🗑️" : status === "delete_attachments" ? "📎🗑️" : "✅");
  }
  const undecided = session.current_batch.filter(id => !decisions.has(id));
  const next = await getPendingBatch(session.mode);
  let reply = results.join(" ") + ` recorded (${decisions.size} decisions)`;
  if (undecided.length) reply += `, ${undecided.length} skipped`;
  reply += "\n";
  if (next.length) {
    await setSession({ current_batch: next.map(i => i.id) });
    const counts = await getPendingCounts();
    reply += `\n📊 ${counts.total_pending} left\n\n`;
    reply += formatBatch(next, session.mode);
  } else {
    await setSession({ current_batch: [] });
    reply += "\n✅ All done! Type /progress then /execute when ready to apply.";
  }
  return reply;
}
async function cmdSkip(): Promise<string> {
  const session = await getSession();
  if (!session.current_batch?.length) return "No active batch. Type /review to start.";
  const now = new Date().toISOString();
  for (const id of session.current_batch) {
    await sbPatch(`/review_queue?id=eq.${id}`, { status: "skip", decided_at: now });
  }
  const next = await getPendingBatch(session.mode);
  if (!next.length) { await setSession({ current_batch: [] }); return "All batches reviewed. Type /progress."; }
  await setSession({ current_batch: next.map(i => i.id) });
  const counts = await getPendingCounts();
  return `Skipped. ${counts.total_pending} pending.\n\n` + formatBatch(next, session.mode);
}
async function cmdProgress(): Promise<string> {
  const counts = await getPendingCounts();
  const session = await getSession();
  return [
    "📊 REVIEW PROGRESS",
    "",
    `Pending:  ${counts.total_pending} (${counts.contacts} contacts · ${counts.imessage} iMsg)`,
    `Queued delete: ${counts.deleted}`,
    `Queued keep:   ${counts.kept}`,
    "",
    `Mode: ${session.mode}`,
    "",
    counts.total_pending > 0
      ? "Type /review to continue · /execute when ready to apply deletes"
      : "✅ All reviewed! Type /execute to apply deletes (runs on your laptop).",
  ].join("\n");
}
async function cmdExecute(): Promise<string> {
  const counts = await getPendingCounts();
  if (counts.deleted === 0) return "Nothing queued for deletion yet. Keep reviewing with /review.";
  return [
    `🚀 READY TO EXECUTE`,
    ``,
    `${counts.deleted} items queued for deletion.`,
    `${counts.kept} items marked keep.`,
    ``,
    `To apply on your laptop, run:`,
    `  cd ~/Documents/Personal/Contacts_Backup_2026-05-24`,
    `  python3 execute_review_decisions.py`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Natural language → AI with conversation memory + full context
// ─────────────────────────────────────────────────────────────────────────────
async function naturalLanguage(message: string): Promise<string> {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });

  const [events, emails, news, irs, history, todos, habits] = await Promise.all([
    safeCall(() => getUpcomingEvents(48), []),
    safeCall(() => getTodaysEmails(), []),
    safeCall(() => getTopNews(5), []),
    safeCall(() => getIrsSnapshot(), null),
    safeCall(() => recentTurns(6), []),
    safeCall(() => getOpenTodos(), []),
    safeCall(() => getAllStreaks(), []),
  ]);

  const calBlock = events.length
    ? events.map(e => `${e.start.toLocaleString("en-US",{weekday:"short",hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} — ${e.title}`).join("\n")
    : "(nothing in next 48h)";
  const emailBlock = emails.length
    ? emails.slice(0,10).map(e => `${e.sender.split("<")[0].trim()}: ${e.subject}`).join("\n")
    : "(no new emails)";
  const newsBlock = news.length ? news.map((n,i) => `${i+1}. ${n.title}`).join("\n") : "(no headlines)";
  const irsBlock = irs ? formatIrsLine(irs) : "(IRS data n/a)";
  const todoBlock = todos.length ? todos.slice(0, 5).map((t) => `- ${t.body}`).join("\n") : "(no open todos)";
  const habitBlock = habits.length
    ? habits.map((h) => `${h.doneToday ? "✅" : "⬜"} ${h.name} (streak ${h.streak}d)`).join("\n")
    : "(no habits)";

  const prompt = `You are Alfred — Dave Douglas Jr.'s personal AI butler. Reply to Dave's latest message.

DAVE just texted you:
"${message}"

DAVE: Reno NV union pipefitter / steamfitter (13yr + 4yr supervision, home book Steamfitters Local 638 NYC, traveling card UA Local 350 Reno, AutoCAD/Revit/BIM certs). DIVORCED, one daughter age 6, single-income household — every dollar matters more. #1 priority: pay off $32k IRS debt by Feb 2027. Background tracks: CAD Technician transition (Wilson Engineering type), Sunrun solar D2D side hustle, @dadailydougie trades content brand (long-game), davedouglasjr.com pending. Real creative lane: battle rap, freestyles, poetry, drones, tech comedy — voice + content backbone, pairs with "information guy" persona. Personality: ENFP, Openness 96%, Conscientiousness 29%, strategic + aggressive + lone-wolf risk-taker. He calls himself Batman and his laptop the Batcave — Alfred can lean into Pennyworth voice occasionally ("Master Wayne", "Sir") but sparingly. Mostly: be a sharp, direct, blue-collar assistant. Scripts + bullet lists + step-by-steps land better than paragraphs. Punchlines and wordplay welcome — he studies battle rap.

NOW: ${now} ET

${irsBlock}

CALENDAR (next 48h):
${calBlock}

EMAILS:
${emailBlock}

NEWS:
${newsBlock}

OPEN TODOS:
${todoBlock}

HABITS TODAY:
${habitBlock}

PRIOR CONVERSATION (last 6 turns):
${memoryBlock(history)}

GUIDELINES:
- Direct, no preamble. Match length to the question — one-line questions get one-line answers.
- Plain text. No markdown bold/italic. Phone-friendly.
- If Dave asks you to DO something you can't (send email, post social, change cron), say so and suggest "ask Claude on the laptop."
- Reference IRS countdown anytime money's discussed.
- When suggesting an action, anchor to: IRS payoff, content brand, or website launch.`;

  return aiChat(prompt, 1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────
async function route(text: string): Promise<string> {
  const trimmed = text.trim();
  const lc = trimmed.toLowerCase();
  const arg = trimmed.includes(" ") ? trimmed.substring(trimmed.indexOf(" ") + 1).trim() : "";

  // System
  if (lc.startsWith("/start") || lc === "/help") return cmdStart();
  if (lc.startsWith("/status"))   return cmdStatus();
  if (lc.startsWith("/version"))  return `Alfred ${VERSION}`;
  if (lc.startsWith("/quiet"))    return cmdQuiet(arg);

  // Capture
  if (lc.startsWith("/note"))     return cmdNote(arg);
  if (lc.startsWith("/idea"))     return cmdIdea(arg);
  if (lc.startsWith("/todos"))    return cmdTodos();
  if (lc.startsWith("/todo"))     return cmdTodo(arg);
  if (lc.startsWith("/done"))     return cmdDone(arg);
  if (lc.startsWith("/win"))      return cmdWin(arg);
  if (lc.startsWith("/jobsite"))  return cmdJobsite(arg);
  if (lc.startsWith("/line"))     return cmdLine(arg);
  if (lc.startsWith("/captures")) return cmdCaptures();
  if (lc.startsWith("/blueprints")) return cmdBlueprints();
  if (lc.startsWith("/bp"))       return cmdBlueprints();

  // Financial — day-to-day
  if (lc.startsWith("/irs"))      return cmdIrs();
  if (lc.startsWith("/pay"))      return cmdPay(arg);
  if (lc.startsWith("/bills"))    return cmdBills();
  if (lc.startsWith("/spending")) return cmdSpending();
  if (lc.startsWith("/expense"))  return cmdExpense(arg);
  if (lc.startsWith("/cash"))     return cmdCash();
  if (lc.startsWith("/forecast")) return cmdForecast();

  // v4 — Wealth modeling
  if (lc.startsWith("/networth")) return cmdNet();
  if (lc.startsWith("/net"))      return cmdNet();
  if (lc.startsWith("/assets"))   return cmdAssets();
  if (lc.startsWith("/asset"))    return cmdAsset(arg);
  if (lc.startsWith("/debts"))    return cmdDebts();
  if (lc.startsWith("/debt"))     return cmdDebt(arg);
  if (lc.startsWith("/payoff"))   return cmdPayoff();
  if (lc.startsWith("/goals"))    return cmdGoals();
  if (lc.startsWith("/goal"))     return cmdGoal(arg);

  // v4 — Investments
  if (lc.startsWith("/quote"))    return cmdStockQuote(arg);
  if (lc.startsWith("/portfolio")) return cmdPortfolio();
  if (lc.startsWith("/buy"))      return cmdBuy(arg);
  if (lc.startsWith("/sell"))     return cmdSell(arg);

  // v4 — Decisions + analysis
  if (lc.startsWith("/decisions")) return cmdDecisions();
  if (lc.startsWith("/decide"))   return cmdLogDecision(arg);
  if (lc.startsWith("/analyze"))  return cmdAnalyze();

  // Habits + journal
  if (lc.startsWith("/habits"))   return cmdHabits();
  if (lc.startsWith("/habit"))    return cmdHabit(arg);
  if (lc.startsWith("/journal"))  return cmdJournal(arg);

  // Briefings
  if (lc.startsWith("/briefing")) return cmdBriefing();
  if (lc.startsWith("/digest"))   return cmdDigest();
  if (lc.startsWith("/recap"))    return cmdRecap();
  if (lc.startsWith("/news"))     return cmdNews();
  if (lc.startsWith("/calendar")) return cmdCalendar();
  if (lc.startsWith("/urgent"))   return cmdUrgent();

  // Review queue
  if (lc.startsWith("/progress")) return cmdProgress();
  if (lc.startsWith("/execute"))  return cmdExecute();
  if (lc.startsWith("/skip"))     return cmdSkip();
  if (lc.startsWith("/review"))   return cmdReview(trimmed.split(/\s+/)[1]?.toLowerCase() ?? "all");

  if (lc.startsWith("/")) return `Unknown command. Try /help`;

  // Maybe it's a review-batch decision
  const decisionResult = await cmdDecide(trimmed);
  if (decisionResult !== null) return decisionResult;

  // Otherwise — natural language to Alfred
  return naturalLanguage(trimmed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function fireAndForget(url: string): void {
  fetch(url, {
    method:"POST",
    headers:{ Authorization:`Bearer ${ANON_KEY}`, "Content-Type":"application/json" },
    body:"{}",
  }).catch(e => console.error("fireAndForget failed:", url, e));
}
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { console.error("context fetch failed:", e); return fallback; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP entry point
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const headerSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!WEBHOOK_SECRET || headerSecret !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try { update = await req.json() as TelegramUpdate; } catch { return new Response("Invalid JSON", { status: 400 }); }

  const message = update.message;
  if (!message?.chat?.id) return new Response(JSON.stringify({ ok:true, ignored:true }), { status:200 });
  if (ALLOWED_CHAT_ID && String(message.chat.id) !== ALLOWED_CHAT_ID) {
    return new Response(JSON.stringify({ ok:true, unauthorized:true }), { status:200 });
  }

  // ── PHOTO INTAKE ────────────────────────────────────────────────────────
  // Telegram delivers `photo` as an array of size variants (smallest → largest).
  // Grab the largest and run it through vision.
  if (message.photo && message.photo.length > 0) {
    return handlePhoto(message.photo, message.caption);
  }
  // ── DOCUMENT INTAKE (PDFs, images sent as document/file) ────────────────
  if (message.document && message.document.file_id) {
    const mime = message.document.mime_type ?? "";
    if (mime.startsWith("image/") || mime === "application/pdf") {
      return handlePhoto([{ file_id: message.document.file_id }], message.caption);
    }
    await sendTelegram(`📎 Got a ${mime || "file"} but I only handle images + PDFs right now.`);
    return new Response(JSON.stringify({ ok: true, ignored: "non-image-document" }), { status: 200 });
  }
  // ── VOICE INTAKE (mic notes + audio files) ──────────────────────────────
  // Transcribe, then run the transcript through the exact same router as text.
  if (message.voice && message.voice.file_id) {
    return handleVoice(message.voice.file_id, message.caption);
  }
  if (message.audio && message.audio.file_id) {
    return handleVoice(message.audio.file_id, message.caption);
  }
  // ── TEXT (the original behavior) ────────────────────────────────────────
  if (!message.text) return new Response(JSON.stringify({ ok:true, ignored:"no-text" }), { status:200 });

  const userText = message.text;
  try {
    const reply = await route(userText);
    const trivial = /^\/(status|version|help|start|todos|habits|bills|spending|irs|news|calendar|captures|blueprints|bp|net|assets|debts|goals|payoff|portfolio|decisions|cash|forecast)/i.test(userText.trim());
    if (!trivial) {
      await saveTurn("user", userText);
      await saveTurn("assistant", reply.slice(0, 2000));
    }
    await sendTelegram(reply);
    await audit({ function_name: "telegram-webhook", action: "reply-sent", details: { command: userText.split(" ")[0] } });
    return new Response(JSON.stringify({ ok:true }), { status:200 });
  } catch (e) {
    console.error("telegram-webhook error:", e);
    await audit({ function_name: "telegram-webhook", action: "error", status: "error", details: { error: String(e), text: userText.slice(0,200) } });
    try { await sendTelegram(`🦇 Error: ${e}\n\nCheck laptop logs.`); } catch {}
    return new Response(JSON.stringify({ error:String(e) }), { status:500 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo / document handler
// ─────────────────────────────────────────────────────────────────────────────
interface TelegramPhotoSize { file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number; }
interface TelegramDocument { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number; }
interface TelegramVoice { file_id: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number; }
interface TelegramMessage {
  chat?: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;   // tap-and-hold mic note (Opus/.oga)
  audio?: TelegramVoice;   // sent audio file
}
interface TelegramUpdate { message?: TelegramMessage; }

async function handlePhoto(photos: TelegramPhotoSize[], caption?: string): Promise<Response> {
  const t0 = Date.now();
  // Largest variant — Telegram orders smallest → largest, last is highest res
  const largest = photos[photos.length - 1];
  const fileId = largest.file_id;

  try {
    // Acknowledge so Telegram doesn't retry while we work
    await sendTelegram("📸 Got it — analyzing...");

    const { bytes, mime } = await downloadTelegramFile(fileId);
    const classified = await readDocument(bytes, mime, caption);
    const result = await actOnClassified(classified);

    const docId = await saveDocument({
      telegram_file_id:   fileId,
      telegram_unique_id: largest.file_unique_id,
      source:             "telegram_photo",
      caption,
      mime_type:          mime,
      bytes:              bytes.length,
      classified,
      action_taken:       result.action_taken,
      action_ref:         result.action_ref,
    });

    const confBar = "█".repeat(Math.round(classified.confidence * 5)) + "░".repeat(5 - Math.round(classified.confidence * 5));
    const reply = `${result.reply}\n\n📊 ${classified.doc_type} ${confBar} ${(classified.confidence * 100).toFixed(0)}% · doc #${docId.id}`;
    await sendTelegram(reply);
    await audit({
      function_name: "telegram-webhook",
      action: "photo-processed",
      details: { doc_type: classified.doc_type, action: result.action_taken, doc_id: docId.id },
      duration_ms: Date.now() - t0,
    });
    return new Response(JSON.stringify({ ok: true, doc_type: classified.doc_type }), { status: 200 });
  } catch (e) {
    console.error("photo handler error:", e);
    await audit({
      function_name: "telegram-webhook",
      action: "photo-failed",
      status: "error",
      details: { error: String(e) },
      duration_ms: Date.now() - t0,
    });
    try { await sendTelegram(`📸❌ Image failed: ${String(e).slice(0, 200)}`); } catch {}
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice handler — transcribe, normalize spoken intent, route like text
// ─────────────────────────────────────────────────────────────────────────────

// A spoken note has no leading slash. If it opens with a bucket keyword
// ("note ...", "todo ...", "remind me to ...", "spent ..."), rewrite it to the
// matching command so it lands in the right place. Everything else passes
// through to route() → Alfred's natural-language brain.
function normalizeSpokenCommand(t: string): string {
  const s = t.trim();
  if (s.startsWith("/")) return s; // already a command (e.g. dictated "slash todo")

  const map: Array<[RegExp, string]> = [
    [/^(?:remind me to|i need to|todo|to do)\b[:,]?\s*/i, "/todo "],
    [/^(?:notes?)\b[:,]?\s*/i,                            "/note "],
    [/^idea\b[:,]?\s*/i,                                  "/idea "],
    [/^(?:win|won)\b[:,]?\s*/i,                           "/win "],
    [/^(?:jobsite|job site)\b[:,]?\s*/i,                  "/jobsite "],
    [/^line\b[:,]?\s*/i,                                  "/line "],
    [/^journal\b[:,]?\s*/i,                               "/journal "],
    [/^(?:expense|spent|log expense)\b[:,]?\s*/i,         "/expense "],
  ];
  for (const [re, cmd] of map) {
    if (re.test(s)) return s.replace(re, cmd);
  }
  return s;
}

async function handleVoice(fileId: string, caption?: string): Promise<Response> {
  const t0 = Date.now();
  try {
    // Acknowledge immediately so Telegram doesn't retry while Gemini works.
    await sendTelegram("🎙️ Got it — transcribing...");

    const { transcript, bytes } = await transcribeVoice(fileId);

    if (!transcript || transcript === UNINTELLIGIBLE) {
      await sendTelegram("🎙️❓ Couldn't make out the audio. Try again or type it.");
      await audit({ function_name: "telegram-webhook", action: "voice-unintelligible", duration_ms: Date.now() - t0 });
      return new Response(JSON.stringify({ ok: true, voice: "unintelligible" }), { status: 200 });
    }

    // A caption sent with the voice note is treated as an extra hint/append.
    const spoken     = caption ? `${transcript} ${caption}` : transcript;
    const normalized = normalizeSpokenCommand(spoken);
    const reply      = await route(normalized);

    // Always echo what was heard — transcription isn't perfect, and Dave needs
    // to trust that "log expense 47 gas" became the right thing.
    const out = `🎙️ "${transcript}"\n\n${reply}`;

    // Voice is always worth remembering (unlike trivial typed lookups).
    await saveTurn("user", `🎙️ ${spoken}`);
    await saveTurn("assistant", reply.slice(0, 2000));
    await sendTelegram(out);
    await audit({
      function_name: "telegram-webhook",
      action: "voice-processed",
      details: { routed_to: normalized.split(" ")[0], chars: transcript.length, bytes },
      duration_ms: Date.now() - t0,
    });
    return new Response(JSON.stringify({ ok: true, voice: true }), { status: 200 });
  } catch (e) {
    console.error("voice handler error:", e);
    await audit({
      function_name: "telegram-webhook",
      action: "voice-failed",
      status: "error",
      details: { error: String(e) },
      duration_ms: Date.now() - t0,
    });
    try { await sendTelegram(`🎙️❌ Voice failed: ${String(e).slice(0, 200)}`); } catch {}
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
