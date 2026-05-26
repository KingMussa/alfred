// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ memory.ts — conversation memory + audit log + cost tracking          ║
// ║                                                                       ║
// ║ Gives Alfred a rolling 14-day memory of Telegram chats so he can      ║
// ║ reference prior context. Also the central logging spine.              ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = {
  Authorization: `Bearer ${KEY}`,
  apikey: KEY,
  "Content-Type": "application/json",
};

// ── CONVERSATION MEMORY ─────────────────────────────────────────────────────
export type Role = "user" | "assistant";

export interface MemoryTurn {
  role: Role;
  content: string;
}

export async function saveTurn(role: Role, content: string, tokens?: number): Promise<void> {
  await fetch(`${URL}/rest/v1/conversation_memory`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ role, content, tokens: tokens ?? null }),
  }).catch(() => {/* logging best-effort */});
}

/** Pull the last N turns chronologically so they can be re-fed to the AI. */
export async function recentTurns(limit = 8): Promise<MemoryTurn[]> {
  const r = await fetch(
    `${URL}/rest/v1/conversation_memory?select=role,content&order=created_at.desc&limit=${limit}`,
    { headers: H },
  );
  const rows = (await r.json()) as MemoryTurn[];
  return rows.reverse();   // oldest first
}

/** Compact recent turns into a single 'past conversation' block for prompts. */
export function memoryBlock(turns: MemoryTurn[]): string {
  if (!turns.length) return "(no prior conversation)";
  return turns
    .map((t) => `${t.role === "user" ? "Dave" : "Alfred"}: ${t.content}`)
    .join("\n");
}

// ── AUDIT LOG ───────────────────────────────────────────────────────────────
export interface AuditEntry {
  function_name: string;
  action: string;
  status?: "ok" | "warn" | "error";
  details?: Record<string, unknown>;
  duration_ms?: number;
}

export async function audit(entry: AuditEntry): Promise<void> {
  await fetch(`${URL}/rest/v1/audit_log`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({
      function_name: entry.function_name,
      action: entry.action,
      status: entry.status ?? "ok",
      details: entry.details ?? {},
      duration_ms: entry.duration_ms ?? null,
    }),
  }).catch(() => {/* best-effort */});
}

/** Wrap an async function with audit timing + error capture. */
export async function audited<T>(
  fnName: string,
  action: string,
  body: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await body();
    await audit({ function_name: fnName, action, status: "ok", duration_ms: Date.now() - t0 });
    return out;
  } catch (e) {
    await audit({
      function_name: fnName,
      action,
      status: "error",
      details: { error: String(e) },
      duration_ms: Date.now() - t0,
    });
    throw e;
  }
}

// ── COST LOG ────────────────────────────────────────────────────────────────
export type CostService = "gemini" | "claude" | "twilio" | "telegram" | "other";

export async function logCost(
  service: CostService,
  units: number,
  costUsd: number,
  functionName: string,
): Promise<void> {
  await fetch(`${URL}/rest/v1/cost_log`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ service, units, cost_usd: costUsd, function_name: functionName }),
  }).catch(() => {/* best-effort */});
}

// ── HEALTH CHECK ────────────────────────────────────────────────────────────
export async function recordHealth(
  functionName: string,
  ok: boolean,
  detail?: string,
): Promise<void> {
  await fetch(`${URL}/rest/v1/health_checks`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ function_name: functionName, ok, detail: detail ?? null }),
  }).catch(() => {/* best-effort */});
}

// ── PREFERENCES ─────────────────────────────────────────────────────────────
export async function getPref<T = unknown>(key: string): Promise<T | null> {
  const r = await fetch(`${URL}/rest/v1/preferences?key=eq.${key}&select=value`, { headers: H });
  const rows = (await r.json()) as Array<{ value: T }>;
  return rows[0]?.value ?? null;
}

export async function setPref(key: string, value: unknown): Promise<void> {
  await fetch(`${URL}/rest/v1/preferences`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

// ── QUIET HOURS CHECK ──────────────────────────────────────────────────────
export async function inQuietHours(): Promise<boolean> {
  const pref = await getPref<{ start: string; end: string; tz: string }>("quiet_hours");
  if (!pref) return false;

  const now = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: pref.tz,
  }); // "HH:MM"
  const t = now.replace(/^24:/, "00:");

  // If start > end → wraps midnight (e.g. 22:00 → 06:30)
  if (pref.start > pref.end) {
    return t >= pref.start || t < pref.end;
  }
  return t >= pref.start && t < pref.end;
}
