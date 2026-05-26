// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ finance.ts — IRS countdown, bill math, spending guard                ║
// ║                                                                       ║
// ║ Anchors Alfred's #1 priority forever: getting Dave to Feb 2027 with   ║
// ║ a $0 IRS balance. Every digest references the countdown.              ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = {
  Authorization: `Bearer ${KEY}`,
  apikey: KEY,
  "Content-Type": "application/json",
};

// Target IRS payoff — locked-in from finances_dave.md
const IRS_TARGET_DATE = new Date("2027-02-01T00:00:00-05:00");

export interface IrsSnapshot {
  balance: number;        // current outstanding
  paid: number;           // total paid to date (sum of payment_applied)
  daysToTarget: number;   // days until Feb 1 2027
  monthsToTarget: number; // rounded for messaging
  monthlyPaceRequired: number; // balance / monthsRemaining
  onTrack: boolean;       // pace required <= $3,000/mo
  progressPct: number;    // 0-100 — paid / (paid + balance)
}

export async function getIrsSnapshot(): Promise<IrsSnapshot> {
  const r = await fetch(
    `${URL}/rest/v1/irs_progress?select=balance,payment_applied&order=recorded_on.desc,id.desc&limit=1`,
    { headers: H },
  );
  const rows = (await r.json()) as Array<{ balance: number; payment_applied: number | null }>;
  const balance = rows[0]?.balance ?? 25000;

  const paidR = await fetch(
    `${URL}/rest/v1/irs_progress?select=payment_applied`,
    { headers: H },
  );
  const allPayments = (await paidR.json()) as Array<{ payment_applied: number | null }>;
  const paid = allPayments.reduce((s, x) => s + (x.payment_applied ?? 0), 0);

  const now = Date.now();
  const daysToTarget = Math.max(0, Math.ceil((IRS_TARGET_DATE.getTime() - now) / 86_400_000));
  const monthsToTarget = Math.max(1, Math.ceil(daysToTarget / 30));
  const monthlyPaceRequired = +(balance / monthsToTarget).toFixed(2);
  const onTrack = monthlyPaceRequired <= 3000;
  const progressPct = Math.min(100, Math.round((paid / (paid + balance)) * 100));

  return { balance, paid, daysToTarget, monthsToTarget, monthlyPaceRequired, onTrack, progressPct };
}

/** One-line IRS status fit for an SMS or briefing header. */
export function formatIrsLine(s: IrsSnapshot): string {
  if (s.balance <= 0) return "💰 IRS: PAID IN FULL 🎉";
  const onTrackEmoji = s.onTrack ? "✅" : "⚠️";
  return `💰 IRS $${s.balance.toLocaleString()} left · ${s.daysToTarget}d to Feb '27 · need $${s.monthlyPaceRequired.toLocaleString()}/mo ${onTrackEmoji}`;
}

/** Record a payment + new balance. */
export async function recordIrsPayment(amount: number, note?: string): Promise<IrsSnapshot> {
  const snap = await getIrsSnapshot();
  const newBalance = Math.max(0, snap.balance - amount);
  await fetch(`${URL}/rest/v1/irs_progress`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ balance: newBalance, payment_applied: amount, note: note ?? `$${amount} payment` }),
  });
  return getIrsSnapshot();
}

// ── BILLS ───────────────────────────────────────────────────────────────────
export interface Bill {
  id: number;
  name: string;
  amount: number;
  due_day: number;
  paid_from: string | null;
  priority: number;
  reminder_days: number[];
  notes: string | null;
}

export async function getActiveBills(): Promise<Bill[]> {
  const r = await fetch(
    `${URL}/rest/v1/bills?active=eq.true&order=priority.asc,due_day.asc&select=*`,
    { headers: H },
  );
  return (await r.json()) as Bill[];
}

/** Compute the next due date for a bill given today. */
export function nextDueDate(bill: Bill, from: Date = new Date()): Date {
  const y = from.getFullYear();
  const m = from.getMonth();
  // Clamp due_day to the actual length of the month
  const lastDay = new Date(y, m + 1, 0).getDate();
  const day = Math.min(bill.due_day, lastDay);
  let due = new Date(y, m, day, 9, 0, 0);
  if (due.getTime() < from.getTime() - 12 * 3600 * 1000) {
    // Already past this month — roll to next month
    const nm = new Date(y, m + 2, 0).getDate();
    due = new Date(y, m + 1, Math.min(bill.due_day, nm), 9, 0, 0);
  }
  return due;
}

export async function hasBillReminderBeenSent(
  billId: number,
  dueDate: Date,
  daysOut: number,
): Promise<boolean> {
  const iso = dueDate.toISOString().slice(0, 10);
  const r = await fetch(
    `${URL}/rest/v1/bill_reminders_sent?bill_id=eq.${billId}&due_date=eq.${iso}&days_out=eq.${daysOut}`,
    { headers: H },
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function markBillReminderSent(
  billId: number,
  dueDate: Date,
  daysOut: number,
): Promise<void> {
  await fetch(`${URL}/rest/v1/bill_reminders_sent`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({
      bill_id: billId,
      due_date: dueDate.toISOString().slice(0, 10),
      days_out: daysOut,
    }),
  });
}

/** Bills due within N days (inclusive) for use in the morning briefing. */
export async function getBillsDueSoon(withinDays: number): Promise<
  Array<{ bill: Bill; due: Date; daysOut: number }>
> {
  const bills = await getActiveBills();
  const now = new Date();
  return bills
    .map((b) => {
      const due = nextDueDate(b, now);
      const daysOut = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
      return { bill: b, due, daysOut };
    })
    .filter((x) => x.daysOut >= 0 && x.daysOut <= withinDays)
    .sort((a, b) => a.daysOut - b.daysOut);
}

// ── SPENDING GUARD ──────────────────────────────────────────────────────────
export interface SpendingStatus {
  category: string;
  monthly_cap: number;
  spent_this_month: number;
  pct: number;
  over: boolean;
}

export async function getSpendingStatus(): Promise<SpendingStatus[]> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const iso = monthStart.toISOString().slice(0, 10);

  const [limitsR, expensesR] = await Promise.all([
    fetch(`${URL}/rest/v1/spending_limits?select=*`, { headers: H }),
    fetch(`${URL}/rest/v1/expenses?spent_at=gte.${iso}&select=category,amount`, { headers: H }),
  ]);
  const limits = (await limitsR.json()) as Array<{ category: string; monthly_cap: number }>;
  const expenses = (await expensesR.json()) as Array<{ category: string; amount: number }>;

  const sumByCat = new Map<string, number>();
  for (const e of expenses) sumByCat.set(e.category, (sumByCat.get(e.category) ?? 0) + Number(e.amount));

  return limits.map((l) => {
    const spent = +(sumByCat.get(l.category) ?? 0).toFixed(2);
    const pct = Math.round((spent / l.monthly_cap) * 100);
    return {
      category: l.category,
      monthly_cap: l.monthly_cap,
      spent_this_month: spent,
      pct,
      over: spent > l.monthly_cap,
    };
  });
}

/** Format spending status as a compact briefing block. */
export function formatSpendingBlock(rows: SpendingStatus[]): string {
  const flagged = rows.filter((r) => r.pct >= 60).sort((a, b) => b.pct - a.pct);
  if (!flagged.length) return "💵 Spending: all categories under 60% — clean.";
  const lines = flagged.slice(0, 5).map((r) => {
    const icon = r.over ? "🔴" : r.pct >= 80 ? "🟠" : "🟡";
    return `${icon} ${r.category}: $${r.spent_this_month} / $${r.monthly_cap} (${r.pct}%)`;
  });
  return `💵 SPENDING WATCH\n` + lines.join("\n");
}
