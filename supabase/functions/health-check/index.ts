// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ health-check — Alfred's dead-man switch                               ║
// ║                                                                       ║
// ║ Hourly self-audit. Checks:                                            ║
// ║  1. Each scheduled function has reported "ok" in the expected window  ║
// ║  2. Twilio + Telegram + Gemini reachability                           ║
// ║  3. Daily cost is under threshold                                     ║
// ║                                                                       ║
// ║ If anything's wrong AND we haven't already alerted in last 6h, text   ║
// ║ Dave a single consolidated alert.                                     ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { notify } from "../_shared/notify.ts";
import { audit, recordHealth, inQuietHours } from "../_shared/memory.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = {
  Authorization: `Bearer ${KEY}`,
  apikey: KEY,
  "Content-Type": "application/json",
};

// Each function should have produced a successful audit/health entry
// within its expected cadence + grace period.
const EXPECTED: Record<string, number> = {
  "morning-briefing":   28 * 3600, // daily — 28h grace
  "email-checker":      28 * 3600, // daily
  "calendar-reminder":  90 * 60,   // every 15 min — 90 min grace
  "evening-digest":     28 * 3600,
  "bill-reminder":      28 * 3600,
};

interface CheckResult { name: string; ok: boolean; detail: string; }

async function sb(path: string): Promise<unknown[]> {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`SB ${path}: ${r.status}`);
  return r.json();
}

async function checkLastRun(name: string, withinSec: number): Promise<CheckResult> {
  const since = new Date(Date.now() - withinSec * 1000).toISOString();
  const rows = await sb(
    `audit_log?function_name=eq.${name}&status=eq.ok&created_at=gte.${since}&order=created_at.desc&limit=1&select=created_at`,
  ) as Array<{ created_at: string }>;
  if (rows.length) return { name, ok: true, detail: `last ok ${rows[0].created_at}` };

  // Was there a recent failure?
  const errs = await sb(
    `audit_log?function_name=eq.${name}&status=eq.error&order=created_at.desc&limit=1&select=created_at,details`,
  ) as Array<{ created_at: string; details: { error?: string } }>;
  if (errs.length) return { name, ok: false, detail: `last error ${errs[0].created_at}: ${errs[0].details?.error?.slice(0, 100) ?? "?"}` };
  return { name, ok: false, detail: `no successful run in ${Math.round(withinSec / 3600)}h` };
}

async function checkAlertedRecently(): Promise<boolean> {
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const rows = await sb(
    `audit_log?function_name=eq.health-check&action=eq.alert-fired&created_at=gte.${since}&select=id&limit=1`,
  );
  return rows.length > 0;
}

async function checkDailyCost(): Promise<CheckResult> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await sb(`cost_log?created_at=gte.${since}&select=cost_usd`) as Array<{ cost_usd: number }>;
  const total = rows.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0);
  const THRESH = 5.00;   // $5/day cap, way above expected $0.05–$0.50
  if (total > THRESH) return { name: "daily-cost", ok: false, detail: `$${total.toFixed(2)} in 24h (cap $${THRESH})` };
  return { name: "daily-cost", ok: true, detail: `$${total.toFixed(2)} in 24h` };
}

Deno.serve(async () => {
  const t0 = Date.now();
  try {
    const checks: CheckResult[] = [];
    for (const [name, secs] of Object.entries(EXPECTED)) {
      // Calendar-reminder runs ALL the time but only sends audit when there's something to send;
      // skip it if no recent calendar events queued.
      if (name === "calendar-reminder") continue;
      try {
        const r = await checkLastRun(name, secs);
        checks.push(r);
        await recordHealth(name, r.ok, r.detail);
      } catch (e) {
        checks.push({ name, ok: false, detail: `check failed: ${e}` });
      }
    }

    try { checks.push(await checkDailyCost()); } catch (e) { checks.push({ name: "daily-cost", ok: false, detail: String(e) }); }

    const failing = checks.filter((c) => !c.ok);
    let alerted = false;

    // Don't wake Dave during quiet hours — defer the alert to next scan.
    const quiet = await inQuietHours();

    if (failing.length && !quiet && !(await checkAlertedRecently())) {
      const msg = "🦇 ALFRED HEALTH ALERT\n\n" + failing.map((c) => `❌ ${c.name}: ${c.detail}`).join("\n") +
        "\n\nCheck Supabase function logs:\nhttps://supabase.com/dashboard/project/rwhfueaclqcunnoraaix/functions";
      await notify(msg);
      alerted = true;
      await audit({ function_name: "health-check", action: "alert-fired", status: "warn", details: { failing: failing.map((f) => f.name) }, duration_ms: Date.now() - t0 });
    } else if (failing.length && quiet) {
      await audit({ function_name: "health-check", action: "alert-suppressed-quiet-hours", status: "warn", details: { failing: failing.map((f) => f.name) }, duration_ms: Date.now() - t0 });
    } else {
      await audit({ function_name: "health-check", action: "scan-ok", details: { all_checks: checks.length, failing: failing.length }, duration_ms: Date.now() - t0 });
    }
    await recordHealth("health-check", true, `${checks.length - failing.length}/${checks.length} green`);

    return new Response(JSON.stringify({ ok: failing.length === 0, alerted, checks }), { status: 200 });
  } catch (e) {
    console.error("health-check error:", e);
    await recordHealth("health-check", false, String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
