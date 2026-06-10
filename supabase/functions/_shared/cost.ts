// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ cost.ts — real LLM cost tracking + a hard daily cap.                   ║
// ║                                                                       ║
// ║ Logs token usage × per-model rates into cost_log on every AI call,    ║
// ║ exposes /cost, and lets the expensive path (Claude Opus vision) check ║
// ║ a rolling-24h cap — over it, callers degrade to free Gemini instead   ║
// ║ of running up an Opus bill. Caps surprise spend, not capability.      ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const DEFAULT_CAP_USD = 5;

// $ per 1M tokens — [input, output]. Gemini 2.5 Flash is on the free tier ($0)
// but we still log its token counts for visibility.
const RATES: Record<string, [number, number]> = {
  "claude-opus-4-8":   [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5":  [1, 5],
  "gemini-2.5-flash":  [0, 0],
};

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const [ri, ro] = RATES[model] ?? [0, 0];
  return (inputTokens * ri + outputTokens * ro) / 1_000_000;
}

// Fire-and-forget — cost logging must NEVER break a real AI call.
export async function logCost(model: string, inputTokens: number, outputTokens: number, fn: string): Promise<void> {
  try {
    const cost = computeCost(model, inputTokens, outputTokens);
    await fetch(`${URL}/rest/v1/cost_log`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({
        service: model,
        units: Math.round(inputTokens + outputTokens),
        cost_usd: Number(cost.toFixed(6)),
        function_name: fn,
      }),
    });
  } catch (e) {
    console.error("logCost failed (non-fatal):", e);
  }
}

async function spendSince(hoursAgo: number): Promise<number> {
  try {
    const since = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const r = await fetch(`${URL}/rest/v1/cost_log?created_at=gte.${since}&select=cost_usd`, { headers: H });
    if (!r.ok) return 0;
    const rows = await r.json() as Array<{ cost_usd: number }>;
    return rows.reduce((s, x) => s + Number(x.cost_usd || 0), 0);
  } catch {
    return 0;
  }
}

export async function getCostCap(): Promise<number> {
  try {
    const r = await fetch(`${URL}/rest/v1/preferences?key=eq.daily_cost_cap&select=value`, { headers: H });
    if (!r.ok) return DEFAULT_CAP_USD;
    const rows = await r.json() as Array<{ value?: { usd?: number } }>;
    return rows[0]?.value?.usd ?? DEFAULT_CAP_USD;
  } catch {
    return DEFAULT_CAP_USD;
  }
}

export async function setCostCap(usd: number): Promise<void> {
  // PATCH if the pref exists, else create it.
  const patch = await fetch(`${URL}/rest/v1/preferences?key=eq.daily_cost_cap`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ value: { usd } }),
  });
  const rows = patch.ok ? await patch.json() as unknown[] : [];
  if (!rows.length) {
    await fetch(`${URL}/rest/v1/preferences`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ key: "daily_cost_cap", value: { usd } }),
    });
  }
}

// Allow a paid (Opus) call only if we're under the rolling-24h cap.
// Fail-open on error — don't block reads because the meter is unreachable.
export async function underCostCap(): Promise<boolean> {
  try {
    const [spent, cap] = await Promise.all([spendSince(24), getCostCap()]);
    return spent < cap;
  } catch {
    return true;
  }
}

export async function costStatus(): Promise<string> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const r = await fetch(`${URL}/rest/v1/cost_log?created_at=gte.${since}&select=service,cost_usd,created_at`, { headers: H });
  const rows = r.ok ? await r.json() as Array<{ service: string; cost_usd: number; created_at: string }> : [];
  const cap = await getCostCap();

  const dayAgo = Date.now() - 86_400_000;
  const today = rows.filter((x) => Date.parse(x.created_at) >= dayAgo).reduce((s, x) => s + Number(x.cost_usd || 0), 0);
  const month = rows.reduce((s, x) => s + Number(x.cost_usd || 0), 0);

  const byModel: Record<string, number> = {};
  for (const x of rows) byModel[x.service] = (byModel[x.service] || 0) + Number(x.cost_usd || 0);
  const lines = Object.entries(byModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
    .map(([m, c]) => `• ${m}: $${c.toFixed(2)}`);

  const flag = today >= cap ? "🔴 OVER CAP — Opus paused, using free Gemini"
    : today >= cap * 0.8 ? "🟡" : "🟢";

  return [
    "💵 AI COST",
    `${flag}`,
    `Last 24h: $${today.toFixed(2)} / $${cap.toFixed(2)} cap`,
    `Last 30d: $${month.toFixed(2)}`,
    ...(lines.length ? ["", "By model (30d):", ...lines] : ["", "(no paid calls logged yet)"]),
    "",
    "Set cap: /costcap <amt>",
  ].join("\n");
}
