// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ bill-reminder — daily 8 AM ET scan of upcoming bills                  ║
// ║                                                                       ║
// ║ For each active bill, computes next due date. If today matches any   ║
// ║ entry in reminder_days (default [3,1,0]) and we haven't sent a text   ║
// ║ for that (bill, due_date, days_out) tuple yet, fire a Telegram.       ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { notify } from "../_shared/notify.ts";
import { logSMS } from "../_shared/db.ts";
import { getActiveBills, nextDueDate, hasBillReminderBeenSent, markBillReminderSent } from "../_shared/finance.ts";
import { audit, recordHealth } from "../_shared/memory.ts";

Deno.serve(async () => {
  const t0 = Date.now();
  try {
    const bills = await getActiveBills();
    const now = new Date();
    const sent: string[] = [];

    for (const bill of bills) {
      const due = nextDueDate(bill, now);
      const daysOut = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);

      if (!bill.reminder_days.includes(daysOut)) continue;
      if (await hasBillReminderBeenSent(bill.id, due, daysOut)) continue;

      const when = daysOut === 0 ? "TODAY" : daysOut === 1 ? "TOMORROW" : `in ${daysOut} days (${due.toLocaleDateString("en-US",{month:"short",day:"numeric"})})`;
      const flag = bill.priority === 1 ? "🔴" : "💸";
      const payFrom = bill.paid_from ? `\nPay from: ${bill.paid_from}` : "";
      const notesLine = bill.notes ? `\n${bill.notes}` : "";
      const msg = `${flag} BILL DUE ${when}\n${bill.name}: $${bill.amount}${payFrom}${notesLine}`;

      await notify(msg);
      await logSMS(msg, "bill_reminder");
      await markBillReminderSent(bill.id, due, daysOut);
      sent.push(`${bill.name} (${daysOut}d)`);
    }

    await audit({
      function_name: "bill-reminder",
      action: "scan-complete",
      details: { bills_checked: bills.length, reminders_sent: sent.length, sent },
      duration_ms: Date.now() - t0,
    });
    await recordHealth("bill-reminder", true);
    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (e) {
    console.error("bill-reminder error:", e);
    await recordHealth("bill-reminder", false, String(e));
    await audit({ function_name: "bill-reminder", action: "failed", status: "error", details: { error: String(e) } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
