// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ wealth.ts — net worth, debt payoff math, goal buckets                 ║
// ║                                                                       ║
// ║ The "where am I" + "where am I going" + "how do I get there faster"   ║
// ║ layer. Anchors every financial conversation to Dave's actual numbers. ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = {
  Authorization: `Bearer ${KEY}`,
  apikey: KEY,
  "Content-Type": "application/json",
};

async function sb(path: string): Promise<unknown[]> {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`SB ${path} ${r.status}`);
  return r.json();
}
async function sbInsert(table: string, row: Record<string, unknown>): Promise<unknown[]> {
  const r = await fetch(`${URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert ${table} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<unknown[]>;
}
async function sbPatch(table: string, query: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${URL}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`patch ${table} ${r.status}: ${await r.text()}`);
}

// ── NET WORTH ───────────────────────────────────────────────────────────────
export interface Asset {
  id: number; name: string; institution: string | null;
  account_type: string; balance: number; notes: string | null;
}
export interface Liability {
  id: number; name: string; balance: number;
  interest_rate: number | null; min_payment: number | null;
  payoff_target: string | null; notes: string | null;
}
export interface NetWorthSnapshot {
  snapshot_date: string;
  assets_total: number;
  liabilities_total: number;
  net_worth: number;
  delta_vs_prior: number | null;
}

export async function getAssets(): Promise<Asset[]> {
  return (await sb("assets?active=eq.true&order=balance.desc&select=*")) as Asset[];
}

export async function getLiabilities(): Promise<Liability[]> {
  return (await sb("liabilities?active=eq.true&order=balance.desc&select=*")) as Liability[];
}

/** Compute current net worth from live asset + liability rows. */
export async function currentNetWorth(): Promise<{
  assets_total: number; liabilities_total: number; net_worth: number;
}> {
  const [assets, debts] = await Promise.all([getAssets(), getLiabilities()]);
  const assets_total      = round2(assets.reduce((s, a) => s + Number(a.balance), 0));
  const liabilities_total = round2(debts.reduce((s, l) => s + Number(l.balance), 0));
  return { assets_total, liabilities_total, net_worth: round2(assets_total - liabilities_total) };
}

/** Snapshot today's net worth. Idempotent — updates existing row for today. */
export async function snapshotNetWorth(notes?: string): Promise<NetWorthSnapshot> {
  const today = new Date().toISOString().slice(0, 10);
  const { assets_total, liabilities_total } = await currentNetWorth();
  const net_worth = round2(assets_total - liabilities_total);

  // Prior snapshot for delta
  const prior = (await sb(
    `net_worth_snapshots?snapshot_date=lt.${today}&order=snapshot_date.desc&limit=1&select=net_worth`,
  )) as Array<{ net_worth: number }>;
  const delta_vs_prior = prior.length ? round2(net_worth - Number(prior[0].net_worth)) : null;

  await fetch(`${URL}/rest/v1/net_worth_snapshots`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      snapshot_date: today,
      assets_total,
      liabilities_total,
      delta_vs_prior,
      notes: notes ?? null,
    }),
  });

  return { snapshot_date: today, assets_total, liabilities_total, net_worth, delta_vs_prior };
}

/** Latest snapshot or live calc. Returns delta vs 7-day-prior + 30-day-prior. */
export async function netWorthReport(): Promise<{
  current: { assets_total: number; liabilities_total: number; net_worth: number };
  delta7: number | null;
  delta30: number | null;
  delta_since_start: number | null;
}> {
  const current = await currentNetWorth();
  const d7  = new Date(Date.now() - 7  * 86_400_000).toISOString().slice(0, 10);
  const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [prior7, prior30, first] = await Promise.all([
    sb(`net_worth_snapshots?snapshot_date=lte.${d7}&order=snapshot_date.desc&limit=1&select=net_worth,snapshot_date`),
    sb(`net_worth_snapshots?snapshot_date=lte.${d30}&order=snapshot_date.desc&limit=1&select=net_worth,snapshot_date`),
    sb(`net_worth_snapshots?order=snapshot_date.asc&limit=1&select=net_worth,snapshot_date`),
  ]) as [Array<{ net_worth: number }>, Array<{ net_worth: number }>, Array<{ net_worth: number }>];
  return {
    current,
    delta7:           prior7.length  ? round2(current.net_worth - Number(prior7[0].net_worth))  : null,
    delta30:          prior30.length ? round2(current.net_worth - Number(prior30[0].net_worth)) : null,
    delta_since_start: first.length  ? round2(current.net_worth - Number(first[0].net_worth))   : null,
  };
}

export function formatNetWorthBlock(r: Awaited<ReturnType<typeof netWorthReport>>): string {
  const sign = (n: number | null) => n === null ? "—" : (n >= 0 ? `+$${n.toLocaleString()}` : `−$${Math.abs(n).toLocaleString()}`);
  const nw = r.current.net_worth;
  const nwStr = nw >= 0 ? `$${nw.toLocaleString()}` : `−$${Math.abs(nw).toLocaleString()}`;
  return [
    `💎 NET WORTH ${nwStr}`,
    `   Assets $${r.current.assets_total.toLocaleString()} · Debts $${r.current.liabilities_total.toLocaleString()}`,
    `   7d ${sign(r.delta7)} · 30d ${sign(r.delta30)} · since start ${sign(r.delta_since_start)}`,
  ].join("\n");
}

// ── DEBT PAYOFF MATH ───────────────────────────────────────────────────────
export interface PayoffPlan {
  liability: Liability;
  monthsRemaining: number;
  payoffDate: string;
  totalInterest: number;
  onTrack: boolean;       // vs payoff_target
}

/** Months to zero given current balance, APR, and monthly payment. */
function monthsToPayoff(balance: number, apr: number, monthly: number): number {
  if (monthly <= 0) return Infinity;
  const r = (apr ?? 0) / 100 / 12;
  if (r === 0) return Math.ceil(balance / monthly);
  // Standard amortization: n = -log(1 - r*B/P) / log(1+r)
  const x = 1 - (r * balance) / monthly;
  if (x <= 0) return Infinity;   // monthly payment less than interest accrual
  return Math.ceil(-Math.log(x) / Math.log(1 + r));
}

export async function payoffReport(): Promise<PayoffPlan[]> {
  const liabilities = await getLiabilities();
  const out: PayoffPlan[] = [];
  for (const l of liabilities) {
    const apr = Number(l.interest_rate ?? 0);
    const pmt = Number(l.min_payment ?? 0);
    const months = monthsToPayoff(Number(l.balance), apr, pmt);
    const payoffDate = isFinite(months)
      ? new Date(Date.now() + months * 30 * 86_400_000).toISOString().slice(0, 10)
      : "9999-12-31";
    const totalInterest = isFinite(months)
      ? round2(months * pmt - Number(l.balance))
      : Number.POSITIVE_INFINITY;
    const onTrack = l.payoff_target
      ? new Date(payoffDate).getTime() <= new Date(l.payoff_target).getTime() + 31 * 86_400_000
      : true;
    out.push({ liability: l, monthsRemaining: months, payoffDate, totalInterest, onTrack });
  }
  return out;
}

export function formatPayoffBlock(plans: PayoffPlan[]): string {
  if (!plans.length) return "✅ No active debt.";
  const lines = ["💸 DEBT PAYOFF"];
  for (const p of plans) {
    const flag = !isFinite(p.monthsRemaining) ? "🔴 PAYMENT TOO LOW" : p.onTrack ? "✅" : "⚠️ LATE";
    const dateStr = p.payoffDate === "9999-12-31"
      ? "never at this pace"
      : new Date(p.payoffDate).toLocaleDateString("en-US", { month: "short", year: "numeric" });
    lines.push(`${flag} ${p.liability.name}`);
    lines.push(`   $${Number(p.liability.balance).toLocaleString()} → ${dateStr} (${p.monthsRemaining}mo)`);
    if (p.liability.payoff_target) {
      const tgt = new Date(p.liability.payoff_target).toLocaleDateString("en-US",{ month:"short", year:"numeric" });
      lines.push(`   Target: ${tgt}${p.onTrack ? "" : " — behind"}`);
    }
  }
  return lines.join("\n");
}

// ── ASSET / LIABILITY MUTATIONS ─────────────────────────────────────────────
export async function updateAssetBalance(id: number, balance: number): Promise<void> {
  await sbPatch("assets", `id=eq.${id}`, { balance });
}
export async function updateLiabilityBalance(id: number, balance: number): Promise<void> {
  await sbPatch("liabilities", `id=eq.${id}`, { balance });
}

// ── GOAL BUCKETS ────────────────────────────────────────────────────────────
export interface GoalBucket {
  id: number; name: string; target_amount: number; current_amount: number;
  target_date: string | null; priority: number; notes: string | null;
}

export async function getGoals(): Promise<GoalBucket[]> {
  return (await sb("goal_buckets?active=eq.true&order=priority.asc,target_date.asc&select=*")) as GoalBucket[];
}

export async function upsertGoal(name: string, target: number, deadline?: string, priority = 5): Promise<void> {
  await fetch(`${URL}/rest/v1/goal_buckets`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      name, target_amount: target,
      target_date: deadline ?? null, priority,
    }),
  });
}

export async function fundGoal(name: string, amount: number): Promise<GoalBucket | null> {
  const rows = (await sb(`goal_buckets?name=eq.${encodeURIComponent(name)}&select=*`)) as GoalBucket[];
  if (!rows.length) return null;
  const g = rows[0];
  const newAmt = round2(Number(g.current_amount) + amount);
  await sbPatch("goal_buckets", `id=eq.${g.id}`, { current_amount: newAmt });
  return { ...g, current_amount: newAmt };
}

export function formatGoalsBlock(goals: GoalBucket[]): string {
  if (!goals.length) return "🎯 No active goals.";
  const lines = ["🎯 GOAL BUCKETS"];
  for (const g of goals) {
    const cur = Number(g.current_amount);
    const tgt = Number(g.target_amount);
    const pct = Math.min(100, Math.round((cur / tgt) * 100));
    const bar = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
    const dateStr = g.target_date
      ? new Date(g.target_date).toLocaleDateString("en-US", { month: "short", year: "numeric" })
      : "no deadline";
    lines.push(`${g.name}`);
    lines.push(`   ${bar} ${pct}% · $${cur.toLocaleString()} / $${tgt.toLocaleString()} · ${dateStr}`);
  }
  return lines.join("\n");
}

// ── helpers ─────────────────────────────────────────────────────────────────
function round2(n: number): number { return Math.round(n * 100) / 100; }
