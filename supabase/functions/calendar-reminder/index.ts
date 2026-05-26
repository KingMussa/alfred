import { getUpcomingEvents } from "../_shared/calendar.ts";
import { notify } from "../_shared/notify.ts";
import { hasReminderBeenSent, markReminderSent, logSMS } from "../_shared/db.ts";
import { audit, recordHealth } from "../_shared/memory.ts";

Deno.serve(async () => {
  try {
    // Look 2 hours ahead so we catch both the 1h and 15m windows
    const events = await getUpcomingEvents(2);
    const now = Date.now();
    let sent = 0;

    for (const event of events) {
      const minUntil = (event.start.getTime() - now) / 60_000;

      if (minUntil >= 55 && minUntil <= 65) {
        if (!(await hasReminderBeenSent(event.id, "1h"))) {
          const t = event.start.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Los_Angeles",
          });
          const msg = `REMINDER: "${event.title}" in 1 hour at ${t}${event.location ? `\nLocation: ${event.location}` : ""}`;
          await notify(msg);
          await markReminderSent(event.id, "1h");
          await logSMS(msg, "calendar_reminder");
          sent++;
        }
      }

      if (minUntil >= 12 && minUntil <= 18) {
        if (!(await hasReminderBeenSent(event.id, "15m"))) {
          const t = event.start.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Los_Angeles",
          });
          const msg = `HEADS UP: "${event.title}" in 15 min at ${t}${event.location ? `\nLocation: ${event.location}` : ""}`;
          await notify(msg);
          await markReminderSent(event.id, "15m");
          await logSMS(msg, "calendar_reminder");
          sent++;
        }
      }
    }

    // Only audit when we actually did something — otherwise calendar-reminder spams audit_log every 15min
    if (sent > 0) {
      await audit({ function_name: "calendar-reminder", action: "reminders-sent", details: { events: events.length, sent } });
    }
    await recordHealth("calendar-reminder", true, `${sent} sent, ${events.length} events`);
    return new Response(JSON.stringify({ eventsChecked: events.length, remindersSent: sent }), {
      status: 200,
    });
  } catch (e) {
    console.error("calendar-reminder error:", e);
    await recordHealth("calendar-reminder", false, String(e));
    await audit({ function_name: "calendar-reminder", action: "failed", status: "error", details: { error: String(e) } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
