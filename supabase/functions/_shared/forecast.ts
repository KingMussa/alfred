// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ forecast.ts — 90-day cash flow projection + daily safe-to-spend       ║
// ║                                                                       ║
// ║ Models cash in (paychecks) vs cash out (bills + average leak) for the ║
// ║ next 90 days. Surfaces danger zones BEFORE Dave hits them.            ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { getActiveBills, nextDueDate } from "./finance.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };

// Dave's working income — pulled from finances_dave.md
const MONTHLY_INCOME_BASELINE = 9000;   // conservative working number
const MONTHLY_INCOME_LIKELY   = 10500;  // typical with some OT

/** Single forecast day. */
export interface ForecastDay {
  date: string;          // YYYY-MM-DD
  income: number;
  bills: number;
  estimatedLeak: number; // avg daily discretionary
  netFlow: number;
  cumulativeBalance: number;
  events: string[];      // human-readable: "🚨 IRS $3000", "Paycheck +$2200"
}

export interface CashFlowReport {
  days: ForecastDay[];
  monthlyIncome: number;
  fixedMonthly: number;
  averageDailyLeak: number;
  freeCashPerMonth: number;
  dangerDates: Array<{ date: string; balance: number }>;
}

/**
 * Build a 90-day forecast.
 * Assumes weekly W2 paycheck Fridays, monthly union deposit ~1st,
 * bills hit on their due_day, and "leak" = avg daily discretionary
 * extracted from last 30 days of expenses table.
 */
export async function buildForecast(
  startingBalance: number,
  horizonDays = 90,
): Promise<CashFlowReport> {
  const bills = await getActiveBills();
  const avgLeak = await averageDailyLeak();

  // Approximate weekly paycheck: monthly baseline / 4.33
  const weeklyW2 = Math.round(MONTHLY_INCOME_BASELINE * 0.85 / 4.33);   // ACCO share
  const monthlyUnion = Math.round(MONTHLY_INCOME_BASELINE * 0.15);      // Local 350 share

  const days: ForecastDay[] = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let cumul = startingBalance;
  const dangerDates: Array<{ date: string; balance: number }> = [];

  for (let i = 0; i < horizonDays; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const events: string[] = [];
    let income = 0;
    let billsToday = 0;

    // Friday paycheck
    if (d.getDay() === 5) {
      income += weeklyW2;
      events.push(`💵 Paycheck +$${weeklyW2}`);
    }
    // 1st of month union deposit
    if (d.getDate() === 1) {
      income += monthlyUnion;
      events.push(`🏛 Union +$${monthlyUnion}`);
    }

    // Bills due today
    for (const b of bills) {
      const due = nextDueDate(b, d);
      if (due.toISOString().slice(0, 10) === d.toISOString().slice(0, 10)) {
        const sign = b.priority === 1 ? "🔴" : "💸";
        billsToday += Number(b.amount);
        events.push(`${sign} ${b.name} -$${b.amount}`);
      }
    }

    const netFlow = income - billsToday - avgLeak;
    cumul += netFlow;

    if (cumul < 0) dangerDates.push({ date: d.toISOString().slice(0, 10), balance: round2(cumul) });

    days.push({
      date: d.toISOString().slice(0, 10),
      income,
      bills: billsToday,
      estimatedLeak: avgLeak,
      netFlow: round2(netFlow),
      cumulativeBalance: round2(cumul),
      events,
    });
  }

  const fixedMonthly = bills.reduce((s, b) => s + Number(b.amount), 0);
  const freeCashPerMonth = round2(MONTHLY_INCOME_BASELINE - fixedMonthly - avgLeak * 30);

  return {
    days,
    monthlyIncome: MONTHLY_INCOME_BASELINE,
    fixedMonthly: round2(fixedMonthly),
    averageDailyLeak: avgLeak,
    freeCashPerMonth,
    dangerDates,
  };
}

/** Compact format for SMS — first 3 paycheck cycles + danger dates. */
export function formatForecastBlock(r: CashFlowReport): string {
  const lines = [
    `🔮 CASH FORECAST (next 90d)`,
    `Income/mo:  $${r.monthlyIncome.toLocaleString()}`,
    `Fixed bills: $${r.fixedMonthly.toLocaleString()}`,
    `Avg daily leak: $${r.averageDailyLeak.toFixed(0)}`,
    `Free cash/mo:  $${r.freeCashPerMonth.toLocaleString()}`,
  ];
  if (r.dangerDates.length) {
    lines.push(``, `🚨 ${r.dangerDates.length} day(s) projected negative:`);
    for (const d of r.dangerDates.slice(0, 5)) {
      lines.push(`   ${d.date}: $${d.balance}`);
    }
  } else {
    lines.push(``, `✅ No negative-balance days projected.`);
  }
  return lines.join("\n");
}

// ── DAILY SAFE-TO-SPEND ────────────────────────────────────────────────────
export interface DailyBudget {
  month_to_date_discretionary: number;
  monthly_discretionary_budget: number;
  days_remaining_in_month: number;
  safe_to_spend_today: number;
  pace_status: "under" | "on" | "over";
}

/**
 * "What can I spend today?" Given month-to-date discretionary spend
 * and total monthly discretionary budget, fan out remaining over
 * remaining days. Pacing flag warns Dave if he's running hot.
 */
export async function dailyBudget(): Promise<DailyBudget> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const daysElapsed = now.getDate();
  const daysRemaining = Math.max(1, daysInMonth - daysElapsed + 1);

  // Pull this month's discretionary expenses (everything in `expenses` table)
  const iso = monthStart.toISOString().slice(0, 10);
  const r = await fetch(`${URL}/rest/v1/expenses?spent_at=gte.${iso}&select=amount`, { headers: H });
  const rows = (await r.json()) as Array<{ amount: number }>;
  const monthToDate = round2(rows.reduce((s, x) => s + Number(x.amount), 0));

  // Monthly discretionary budget = sum of spending_limits monthly_cap
  const limR = await fetch(`${URL}/rest/v1/spending_limits?select=monthly_cap`, { headers: H });
  const limits = (await limR.json()) as Array<{ monthly_cap: number }>;
  const monthlyBudget = limits.reduce((s, x) => s + Number(x.monthly_cap), 0);

  const remainingBudget = monthlyBudget - monthToDate;
  const safeToSpendToday = Math.max(0, round2(remainingBudget / daysRemaining));

  const expectedByNow = (monthlyBudget / daysInMonth) * daysElapsed;
  const pace_status: DailyBudget["pace_status"] =
    monthToDate > expectedByNow * 1.1 ? "over"
    : monthToDate < expectedByNow * 0.9 ? "under"
    : "on";

  return {
    month_to_date_discretionary: monthToDate,
    monthly_discretionary_budget: monthlyBudget,
    days_remaining_in_month: daysRemaining,
    safe_to_spend_today: safeToSpendToday,
    pace_status,
  };
}

export function formatDailyBudgetBlock(b: DailyBudget): string {
  const paceIcon = b.pace_status === "over" ? "🔴" : b.pace_status === "under" ? "✅" : "🟡";
  return [
    `💵 TODAY: $${b.safe_to_spend_today.toFixed(0)} safe to spend`,
    `${paceIcon} MTD discretionary: $${b.month_to_date_discretionary.toFixed(0)} / $${b.monthly_discretionary_budget} (${b.pace_status} pace, ${b.days_remaining_in_month}d left)`,
  ].join("\n");
}

// ── helpers ────────────────────────────────────────────────────────────────
async function averageDailyLeak(): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const r = await fetch(`${URL}/rest/v1/expenses?spent_at=gte.${since}&select=amount`, { headers: H });
  const rows = (await r.json()) as Array<{ amount: number }>;
  if (!rows.length) return 50;     // safe default until Dave logs expenses
  const total = rows.reduce((s, x) => s + Number(x.amount), 0);
  return round2(total / 30);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
