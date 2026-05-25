import { getNewEmails } from "../_shared/gmail.ts";
import { aiChat } from "../_shared/ai.ts";
import { notify } from "../_shared/notify.ts";
import { hasProcessedEmail, markEmailProcessed, logSMS } from "../_shared/db.ts";

/**
 * Evening urgent-email recap.
 *
 * Scheduled at 6 PM ET (22 UTC during EDT, 23 UTC during EST). Scans
 * emails received in the last 12 hours — which covers everything since
 * the 6 AM morning briefing. Filters to score >= 8 and sends ONE
 * consolidated Telegram message with all the day's urgent items.
 *
 * Previously ran every 30 min; switched to once-a-day evening recap
 * on 2026-05-23 at Dave's request — less buzzing during the workday.
 */
Deno.serve(async () => {
  try {
    // 12-hour window — covers the workday since the 6 AM briefing
    const emails = await getNewEmails(60 * 12);
    const alerts: string[] = [];

    for (const email of emails) {
      if (await hasProcessedEmail(email.id)) continue;

      const scoreStr = await aiChat(
        `Rate the urgency of this email for Dave Douglas Jr., a steamfitter/tradesman in NYC. Reply with ONLY a number 1-10.

From: ${email.sender}
Subject: ${email.subject}
Preview: ${email.snippet}

Scale:
1-3 = spam / promotions / irrelevant
4-6 = can wait, read later
7-8 = should read today
9-10 = urgent, needs immediate attention`,
        15,
      );

      const score = parseInt(scoreStr.match(/\d+/)?.[0] ?? "0", 10);
      const shouldAlert = score >= 8;

      await markEmailProcessed(email.id, email.subject, email.sender, score, shouldAlert);

      if (shouldAlert) {
        const name = email.sender.split("<")[0].trim().replace(/"/g, "");
        alerts.push(`From: ${name}\nSubject: ${email.subject}\nPreview: ${email.snippet.slice(0, 100)}`);
      }
    }

    if (alerts.length > 0) {
      const header =
        alerts.length === 1
          ? "📬 EVENING RECAP — 1 urgent email today:"
          : `📬 EVENING RECAP — ${alerts.length} urgent emails today:`;
      const msg = header + "\n\n" + alerts.join("\n---\n");
      await notify(msg);
      await logSMS(msg, "email_alert");
    }

    return new Response(
      JSON.stringify({ checked: emails.length, alerted: alerts.length }),
      { status: 200 },
    );
  } catch (e) {
    console.error("email-checker error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
