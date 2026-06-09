// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ capture.ts — quick-capture parsers + habit/journal/expense writers   ║
// ║                                                                       ║
// ║ This is the "text Alfred and it lands in the right table" layer.     ║
// ║ /note, /idea, /todo, /expense, /weight, /sleep, /water, /jobsite,    ║
// ║ /habit, /journal — all funnel through here.                          ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = {
  Authorization: `Bearer ${KEY}`,
  apikey: KEY,
  "Content-Type": "application/json",
};

async function sbInsert(table: string, row: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`SB insert ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbSelect(path: string): Promise<unknown[]> {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`SB select ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(path: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

// ── GENERIC CAPTURE (/note /idea /todo /jobsite /win /quote /question) ──────
type CaptureKind = "note" | "idea" | "todo" | "jobsite" | "win" | "quote" | "question";

export async function saveCapture(
  kind: CaptureKind,
  body: string,
  tags: string[] = [],
): Promise<{ id: number }> {
  // Pull #hashtags off the end
  const inlineTags = Array.from(body.matchAll(/#(\w+)/g)).map((m) => m[1]);
  const cleanBody = body.replace(/#\w+/g, "").trim();
  const allTags = [...new Set([...tags, ...inlineTags])];
  const row = (await sbInsert("captures", {
    kind,
    body: cleanBody,
    tags: allTags,
  })) as Array<{ id: number }>;
  return row[0];
}

export async function getRecentCaptures(
  kind: CaptureKind | "all",
  sinceHours: number,
): Promise<Array<{ id: number; kind: string; body: string; created_at: string; done: boolean }>> {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const kindFilter = kind === "all" ? "" : `&kind=eq.${kind}`;
  const rows = (await sbSelect(
    `captures?created_at=gte.${since}${kindFilter}&order=created_at.desc&limit=50&select=*`,
  )) as Array<{ id: number; kind: string; body: string; created_at: string; done: boolean }>;
  return rows;
}

export async function getOpenTodos(): Promise<Array<{ id: number; body: string }>> {
  return (await sbSelect(
    "captures?kind=eq.todo&done=eq.false&order=created_at.asc&select=id,body",
  )) as Array<{ id: number; body: string }>;
}

export async function completeTodo(id: number): Promise<void> {
  await sbPatch(`captures?id=eq.${id}`, { done: true });
}

// ── EXPENSE ─────────────────────────────────────────────────────────────────
const CATEGORY_ALIASES: Record<string, string> = {
  // ATM
  atm: "atm", cash: "atm", withdrawal: "atm",
  // Dining
  dining: "dining", food: "dining", restaurant: "dining", lunch: "dining", dinner: "dining",
  coffee: "dining", takeout: "dining",
  // Casino
  casino: "casino", gambling: "casino", bet: "casino", lottery: "casino",
  // Amazon
  amazon: "amazon", amzn: "amazon", online: "amazon",
  // Gas
  gas: "gas", fuel: "gas", shell: "gas", bp: "gas",
  // Groceries
  groceries: "groceries", grocery: "groceries", supermarket: "groceries",
  // Apple cash / zelle
  zelle: "apple_cash", venmo: "apple_cash", "apple-cash": "apple_cash", cashapp: "apple_cash",
  apple_cash: "apple_cash",
  // Subs
  subscription: "subscription", sub: "subscription", recurring: "subscription",
  // Gear
  gear: "gear", tools: "gear", boots: "gear", "work-gear": "gear",
};

export interface ParsedExpense {
  amount: number;
  category: string;
  note: string;
  [k: string]: unknown;
}

export function parseExpense(text: string): ParsedExpense | null {
  // Accept: "75 atm pulled cash" / "$22.50 dining lunch with crew" / "atm 75"
  const amtMatch = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!amtMatch) return null;
  const amount = parseFloat(amtMatch[1]);
  if (!isFinite(amount) || amount <= 0) return null;

  const words = text.toLowerCase().replace(/\$?\s*\d+(?:\.\d{1,2})?/, "").trim().split(/\s+/);
  let category = "other";
  let categoryWord: string | undefined;
  for (const w of words) {
    if (CATEGORY_ALIASES[w]) {
      category = CATEGORY_ALIASES[w];
      categoryWord = w;
      break;
    }
  }
  const note = words.filter((w) => w !== categoryWord).join(" ").trim() || categoryWord || "";
  return { amount, category, note };
}

export async function saveExpense(e: ParsedExpense): Promise<void> {
  await sbInsert("expenses", e);
}

// ── HABIT TRACKING ──────────────────────────────────────────────────────────
export interface Habit { id: number; name: string; emoji: string | null; target: string | null; }

export async function getHabits(): Promise<Habit[]> {
  return (await sbSelect("habits?active=eq.true&order=id.asc&select=*")) as Habit[];
}

export async function logHabit(habitId: number, done = true, note?: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await fetch(`${URL}/rest/v1/habit_logs`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ habit_id: habitId, log_date: today, done, note: note ?? null }),
  });
}

export async function getHabitStreak(habitId: number): Promise<number> {
  const rows = (await sbSelect(
    `habit_logs?habit_id=eq.${habitId}&done=eq.true&order=log_date.desc&limit=180&select=log_date`,
  )) as Array<{ log_date: string }>;
  if (!rows.length) return 0;
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < rows.length; i++) {
    const d = new Date(rows[i].log_date + "T00:00:00");
    const expected = new Date(today);
    expected.setDate(today.getDate() - i);
    if (d.getTime() !== expected.getTime()) break;
    streak++;
  }
  return streak;
}

export async function getAllStreaks(): Promise<Array<Habit & { streak: number; doneToday: boolean }>> {
  const habits = await getHabits();
  const out: Array<Habit & { streak: number; doneToday: boolean }> = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const h of habits) {
    const streak = await getHabitStreak(h.id);
    const todayR = (await sbSelect(
      `habit_logs?habit_id=eq.${h.id}&log_date=eq.${today}&select=done`,
    )) as Array<{ done: boolean }>;
    out.push({ ...h, streak, doneToday: todayR[0]?.done ?? false });
  }
  return out;
}

export function formatHabitsBlock(rows: Array<Habit & { streak: number; doneToday: boolean }>): string {
  if (!rows.length) return "";
  const lines = rows.map((h) => {
    const mark = h.doneToday ? "✅" : h.streak > 0 ? "⏳" : "⬜";
    const streak = h.streak > 0 ? ` 🔥${h.streak}d` : "";
    return `${mark} ${h.emoji ?? "•"} ${h.name}${streak}`;
  });
  return "🏆 HABITS\n" + lines.join("\n");
}

// ── JOURNAL ─────────────────────────────────────────────────────────────────
export async function saveJournal(body: string, mood?: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await fetch(`${URL}/rest/v1/journal`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ entry_date: today, body, mood: mood ?? null }),
  });
}

// ── CONTENT IDEA (richer than generic capture) ──────────────────────────────
export async function saveContentIdea(hook: string, platform = "any", format = "any"): Promise<void> {
  await sbInsert("content_ideas", { hook, platform, format });
}

export async function getOpenContentIdeas(): Promise<Array<{ id: number; hook: string; platform: string; format: string; status: string; created_at: string }>> {
  return (await sbSelect(
    "content_ideas?status=eq.idea&order=created_at.desc&limit=20&select=*",
  )) as Array<{ id: number; hook: string; platform: string; format: string; status: string; created_at: string }>;
}
