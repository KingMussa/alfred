// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ market.ts — FMP (Financial Modeling Prep) wrapper                     ║
// ║                                                                       ║
// ║ Quote / batch quote / crypto / index data with 30-minute cache.       ║
// ║ Gracefully no-ops if FMP_API_KEY isn't set yet — returns null + tells ║
// ║ Dave how to enable it.                                                ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FMP_KEY = Deno.env.get("FMP_API_KEY") ?? "";
const H = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };

const CACHE_TTL_MIN = 30;  // refresh quotes every 30 min to stay under 250/day

export interface Quote {
  symbol: string;
  price: number;
  changePct: number;
  changesPercentage?: number;
  name?: string;
  exchange?: string;
  open?: number;
  dayLow?: number;
  dayHigh?: number;
  yearHigh?: number;
  yearLow?: number;
  marketCap?: number;
  volume?: number;
  earningsAnnouncement?: string;
  raw?: unknown;
}

export function marketConfigured(): boolean { return FMP_KEY.length > 0; }

/**
 * Get one quote. Cached up to CACHE_TTL_MIN. Returns null if FMP unconfigured.
 *
 * Uses the new /stable/quote endpoint — the /api/v3/quote/{sym} endpoint was
 * retired August 31, 2025. Batch endpoint (/stable/batch-quote) is premium-only,
 * so we parallelize singles for getQuotes() instead.
 */
export async function getQuote(symbol: string): Promise<Quote | null> {
  if (!FMP_KEY) return null;
  const sym = symbol.toUpperCase().trim();
  const cached = await readCache(sym);
  if (cached) return cached;

  const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${sym}&apikey=${FMP_KEY}`);
  if (!r.ok) {
    console.error(`FMP quote ${sym} failed: ${r.status}`);
    return null;
  }
  const data = (await r.json()) as Array<Record<string, unknown>> | { "Error Message"?: string };
  if (!Array.isArray(data)) {
    console.error(`FMP quote ${sym} error:`, (data as { "Error Message"?: string })["Error Message"]);
    return null;
  }
  if (!data.length) return null;
  const q = data[0];
  const quote: Quote = {
    symbol: sym,
    price: Number(q.price),
    changePct: Number(q.changePercentage ?? q.changesPercentage),
    name: q.name as string,
    exchange: q.exchange as string,
    open: Number(q.open),
    dayLow: Number(q.dayLow),
    dayHigh: Number(q.dayHigh),
    yearHigh: Number(q.yearHigh),
    yearLow: Number(q.yearLow),
    marketCap: Number(q.marketCap),
    volume: Number(q.volume),
    raw: q,
  };
  await writeCache(quote);
  return quote;
}

/**
 * Batch quote — cache-aware. Free tier doesn't support batch endpoint so we
 * fan out single requests in parallel. Anything cached within TTL skips network.
 */
export async function getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  if (!FMP_KEY) return new Map();
  const out = new Map<string, Quote>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase().trim()))];

  // Pull what's cached first
  const needFetch: string[] = [];
  for (const s of uniq) {
    const c = await readCache(s);
    if (c) out.set(s, c);
    else needFetch.push(s);
  }

  // Parallel singles for the rest — FMP free tier doesn't allow batch endpoint
  if (needFetch.length) {
    const fetched = await Promise.all(needFetch.map((s) => getQuote(s)));
    fetched.forEach((q, i) => {
      if (q) out.set(needFetch[i], q);
    });
  }
  return out;
}

/** Format a single quote for SMS. */
export function formatQuote(q: Quote): string {
  const arrow = q.changePct >= 0 ? "▲" : "▼";
  const pct = q.changePct.toFixed(2);
  const lines = [
    `${arrow} ${q.symbol} $${q.price.toFixed(2)} (${pct}%)`,
  ];
  if (q.name) lines.push(`   ${q.name}`);
  if (q.dayLow && q.dayHigh) lines.push(`   Day: $${q.dayLow}–$${q.dayHigh}`);
  if (q.yearLow && q.yearHigh) lines.push(`   52W: $${q.yearLow}–$${q.yearHigh}`);
  return lines.join("\n");
}

/** Holdings → live valuation. */
export interface HoldingWithQuote {
  id: number; symbol: string; qty: number; cost_basis: number;
  account: string; asset_class: string;
  currentPrice: number | null;
  currentValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
}

export async function valuateHoldings(holdings: Array<{ id: number; symbol: string; qty: number; cost_basis: number; account: string; asset_class: string }>): Promise<HoldingWithQuote[]> {
  if (!holdings.length) return [];
  const quotes = await getQuotes(holdings.map((h) => h.symbol));
  return holdings.map((h) => {
    const q = quotes.get(h.symbol.toUpperCase());
    const currentPrice = q?.price ?? null;
    const currentValue = currentPrice !== null ? round2(Number(h.qty) * currentPrice) : null;
    const pnl = currentValue !== null ? round2(currentValue - Number(h.cost_basis)) : null;
    const pnlPct = currentValue !== null && Number(h.cost_basis) > 0
      ? round2(((currentValue - Number(h.cost_basis)) / Number(h.cost_basis)) * 100)
      : null;
    return { ...h, currentPrice, currentValue, pnl, pnlPct };
  });
}

// ── CACHE ───────────────────────────────────────────────────────────────────
async function readCache(symbol: string): Promise<Quote | null> {
  const r = await fetch(`${URL}/rest/v1/quote_cache?symbol=eq.${symbol}&select=*`, { headers: H });
  const rows = (await r.json()) as Array<{ price: number; change_pct: number; payload: Quote; fetched_at: string }>;
  if (!rows.length) return null;
  const age = (Date.now() - new Date(rows[0].fetched_at).getTime()) / 60_000;
  if (age > CACHE_TTL_MIN) return null;
  return rows[0].payload;
}

async function writeCache(q: Quote): Promise<void> {
  await fetch(`${URL}/rest/v1/quote_cache`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      symbol: q.symbol,
      price: q.price,
      change_pct: q.changePct,
      payload: q,
      fetched_at: new Date().toISOString(),
    }),
  }).catch(() => {/* best effort */});
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
