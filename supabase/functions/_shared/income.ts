// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ income.ts — income by stream + the tax-reserve guardrail.              ║
// ║                                                                       ║
// ║ Dave clawed out of a $32k IRS hole. His solar (Sunrun) commission is  ║
// ║ 1099 — UNTAXED — so every solar dollar quietly builds a NEW tax bill. ║
// ║ This logs income per stream and auto-reserves a % of 1099 income into ║
// ║ a running tax set-aside, with the next estimated-tax date surfaced.   ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const DEFAULT_RESERVE_PCT = 30;

// YYYY-MM-DD in Dave's timezone (Reno).
function laDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

// Map free-text to a canonical stream.
export function normalizeStream(s: string): string {
  const lc = s.toLowerCase();
  if (/(union|acco|aco|pipe|w2|check|scale)/.test(lc)) return "union";
  if (/(solar|sunrun|d2d|door|onsite)/.test(lc))       return "solar";
  if (/(creative|content|rap|music|youtube|tiktok|drone|comedy|gig|poetry)/.test(lc)) return "creative";
  if (/(spouse|wife|bank|partner)/.test(lc))           return "spouse";
  return "other";
}

// 1099 / untaxed streams need a reserve; W2 (union, spouse) is already withheld.
export function is1099(stream: string): boolean {
  return stream === "solar" || stream === "creative";
}

export async function getReservePct(): Promise<number> {
  try {
    const r = await fetch(`${URL}/rest/v1/preferences?key=eq.tax_reserve_pct&select=value`, { headers: H });
    if (!r.ok) return DEFAULT_RESERVE_PCT;
    const rows = await r.json() as Array<{ value?: { pct?: number } }>;
    return rows[0]?.value?.pct ?? DEFAULT_RESERVE_PCT;
  } catch {
    return DEFAULT_RESERVE_PCT;
  }
}

export async function setReservePct(pct: number): Promise<void> {
  const r = await fetch(`${URL}/rest/v1/preferences?key=eq.tax_reserve_pct`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ value: { pct } }),
  });
  if (!r.ok) throw new Error(`setReservePct ${r.status}: ${await r.text()}`);
}

export interface IncomeRow {
  id: number; stream: string; gross: number; is_1099: boolean; tax_reserved: number;
}

export async function logIncome(streamRaw: string, gross: number, note?: string): Promise<{ row: IncomeRow; pct: number }> {
  const stream = normalizeStream(streamRaw);
  const untaxed = is1099(stream);
  const pct = await getReservePct();
  const tax_reserved = untaxed ? Math.round(gross * pct) / 100 : 0;

  const r = await fetch(`${URL}/rest/v1/income`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ stream, gross, is_1099: untaxed, tax_reserved, note: note ?? null, received_at: laDate() }),
  });
  if (!r.ok) throw new Error(`income insert ${r.status}: ${await r.text()}`);
  const rows = await r.json() as IncomeRow[];
  return { row: rows[0], pct };
}

// Next IRS estimated-tax due date (15 Apr / 15 Jun / 15 Sep / 15 Jan).
export function nextEstimatedTaxDate(today = laDate()): { date: string; label: string } {
  const y = Number(today.slice(0, 4));
  const dates = [
    { date: `${y}-04-15`,     label: "Q1" },
    { date: `${y}-06-15`,     label: "Q2" },
    { date: `${y}-09-15`,     label: "Q3" },
    { date: `${y + 1}-01-15`, label: "Q4" },
  ];
  for (const d of dates) if (d.date >= today) return d;
  return { date: `${y + 1}-04-15`, label: "Q1" };
}

// One-liner for the morning brief when an estimated-tax date is near.
export function estimatedTaxReminder(today = laDate()): string | null {
  const due = nextEstimatedTaxDate(today);
  const days = Math.round((Date.parse(due.date) - Date.parse(today)) / 86_400_000);
  if (days >= 0 && days <= 10) {
    return `🧾 Estimated taxes (${due.label}) due in ${days}d (${due.date}) — see /tax for your set-aside.`;
  }
  return null;
}

export async function taxStatus(): Promise<string> {
  const year = laDate().slice(0, 4);
  const r = await fetch(
    `${URL}/rest/v1/income?received_at=gte.${year}-01-01&select=stream,gross,tax_reserved,is_1099`,
    { headers: H },
  );
  const rows = r.ok ? await r.json() as Array<{ stream: string; gross: number; tax_reserved: number; is_1099: boolean }> : [];
  const pct = await getReservePct();

  const reserved  = rows.reduce((s, x) => s + Number(x.tax_reserved || 0), 0);
  const gross1099 = rows.filter((x) => x.is_1099).reduce((s, x) => s + Number(x.gross || 0), 0);

  const byStream: Record<string, number> = {};
  for (const x of rows) byStream[x.stream] = (byStream[x.stream] || 0) + Number(x.gross || 0);
  const streamLines = Object.entries(byStream)
    .sort((a, b) => b[1] - a[1])
    .map(([s, g]) => `• ${s}: $${g.toLocaleString()}`);

  const due = nextEstimatedTaxDate();
  const out = [
    `💰 TAX RESERVE — ${year}`,
    `Set aside (${pct}% of 1099): $${reserved.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    `1099 income YTD: $${gross1099.toLocaleString()}`,
  ];
  if (streamLines.length) out.push("", "Income by stream YTD:", ...streamLines);
  out.push("", `Next estimated-tax due: ${due.label} ${due.date}`,
    `Log income: /income <amt> <stream> · rate: /taxrate <pct>`);
  return out.join("\n");
}
