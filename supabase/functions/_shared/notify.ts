/**
 * Multi-channel notification dispatcher.
 *
 * Fires SMS (Gmail→carrier gateway) and Telegram in parallel. One channel
 * failing does NOT block the other — we use Promise.allSettled and log per-
 * channel errors. As long as one channel delivers, Dave sees the alert.
 *
 * Callers used to import sendSMS directly; they now import notify(). The
 * signature stays simple: pass the message body, get a Promise<void>.
 */

import { sendSMS, smsConfigured } from "./twilio.ts";
import { sendTelegram, telegramConfigured } from "./telegram.ts";

export interface NotifyResult {
  sms: "ok" | "skipped" | { error: string };
  telegram: "ok" | "skipped" | { error: string };
}

export async function notify(body: string): Promise<NotifyResult> {
  const tasks: Array<Promise<["sms" | "telegram", "ok" | "skipped" | { error: string }]>> = [];

  if (smsConfigured()) {
    tasks.push(
      sendSMS(body)
        .then(() => ["sms", "ok"] as const)
        .catch((e) => ["sms", { error: String(e) }] as const),
    );
  } else {
    tasks.push(Promise.resolve(["sms", "skipped"] as const));
  }

  if (telegramConfigured()) {
    tasks.push(
      sendTelegram(body)
        .then(() => ["telegram", "ok"] as const)
        .catch((e) => ["telegram", { error: String(e) }] as const),
    );
  } else {
    tasks.push(Promise.resolve(["telegram", "skipped"] as const));
  }

  const settled = await Promise.all(tasks);
  const result: NotifyResult = { sms: "skipped", telegram: "skipped" };
  for (const [channel, outcome] of settled) {
    result[channel] = outcome;
  }

  if (typeof result.sms === "object") console.error("notify: SMS failed", result.sms.error);
  if (typeof result.telegram === "object") console.error("notify: Telegram failed", result.telegram.error);

  const allFailed =
    typeof result.sms !== "string" && typeof result.telegram !== "string";
  if (allFailed) {
    throw new Error(`notify: all channels failed — sms=${JSON.stringify(result.sms)} tg=${JSON.stringify(result.telegram)}`);
  }

  return result;
}
