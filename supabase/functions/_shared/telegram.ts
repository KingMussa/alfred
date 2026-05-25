/**
 * Telegram sender — uses the Bot API to message Dave directly.
 *
 * Added 2026-05-23 as a second delivery channel alongside the Gmail→SMS
 * gateway. Telegram is free, instant, supports formatting, and isn't subject
 * to US carrier filtering (Error 30032, A2P 10DLC, etc.).
 *
 * Requires:
 *   - TELEGRAM_BOT_TOKEN  — from @BotFather (looks like 123456:ABC-xxx)
 *   - TELEGRAM_CHAT_ID    — Dave's personal chat with the bot (numeric, can be negative for groups)
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

const TG_MAX = 4096; // Telegram per-message hard limit

export function telegramConfigured(): boolean {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}

export async function sendTelegram(body: string): Promise<void> {
  if (!telegramConfigured()) {
    throw new Error("Telegram not configured: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  }

  for (const chunk of splitMessage(body, TG_MAX)) {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: chunk,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram send error:", err);
      throw new Error(`Telegram send ${res.status}: ${err}`);
    }
  }
}

function splitMessage(str: string, size: number): string[] {
  if (str.length <= size) return [str];
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}
