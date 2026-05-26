// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ daily-networth — snapshot net worth every day                         ║
// ║                                                                       ║
// ║ Fires 11 PM PT (06:00 UTC). Recalculates total assets vs liabilities, ║
// ║ writes to net_worth_snapshots, optionally pings Dave if delta is      ║
// ║ exceptional (|±$1000| in a day). Quiet-hours respected for the ping.  ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { notify } from "../_shared/notify.ts";
import { snapshotNetWorth, netWorthReport, formatNetWorthBlock } from "../_shared/wealth.ts";
import { audit, recordHealth, inQuietHours } from "../_shared/memory.ts";

const PING_THRESHOLD = 1000;   // |delta| > $1000 → text Dave

Deno.serve(async () => {
  const t0 = Date.now();
  try {
    const snap = await snapshotNetWorth("daily-snapshot");
    const report = await netWorthReport();

    let alerted = false;
    const delta = snap.delta_vs_prior ?? 0;
    if (Math.abs(delta) >= PING_THRESHOLD && !(await inQuietHours())) {
      const direction = delta > 0 ? "📈 UP" : "📉 DOWN";
      const msg = `${direction} $${Math.abs(delta).toLocaleString()} today.\n\n${formatNetWorthBlock(report)}`;
      await notify(msg);
      alerted = true;
    }

    await audit({
      function_name: "daily-networth",
      action: "snapshot",
      details: {
        net_worth: snap.net_worth,
        delta: snap.delta_vs_prior,
        alerted,
      },
      duration_ms: Date.now() - t0,
    });
    await recordHealth("daily-networth", true);

    return new Response(JSON.stringify({ ok: true, snap, alerted }), { status: 200 });
  } catch (e) {
    console.error("daily-networth error:", e);
    await recordHealth("daily-networth", false, String(e));
    await audit({ function_name: "daily-networth", action: "failed", status: "error", details: { error: String(e) } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
