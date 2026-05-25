/**
 * SMS sender — uses Gmail API → carrier email-to-SMS gateway.
 *
 * Replaces Twilio (2026-05-23) — toll-free numbers require US carrier
 * verification (Error 30032) which takes 1-3 weeks. Gmail-to-gateway is
 * free, instant, and uses the same Gmail OAuth we already have.
 *
 * Filename kept as twilio.ts to avoid touching the 3 callers; the EXPORT
 * (`sendSMS`) is unchanged.
 *
 * Requires:
 *   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN with `gmail.send` scope
 *   - FROM_EMAIL (the Gmail address sending the message)
 *   - USER_CELL_GATEWAY (e.g. 9175182963@tmomail.net for T-Mobile)
 */

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "";        // bklyncaviar@gmail.com
const TO_GATEWAY = Deno.env.get("USER_CELL_GATEWAY") ?? ""; // 9175182963@tmomail.net
const SMS_DISABLED = (Deno.env.get("SMS_DISABLED") ?? "").toLowerCase() === "true";

/**
 * SMS is configured when both the sender and gateway are set, AND the
 * SMS_DISABLED kill-switch is not on. Lets us turn off SMS without losing
 * the config — just flip SMS_DISABLED.
 */
export function smsConfigured(): boolean {
  return !SMS_DISABLED && FROM_EMAIL.length > 0 && TO_GATEWAY.length > 0;
}

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Reuse cached token within one cold-start (Edge Function lifetime)
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 30_000) {
    return cachedAccessToken.value;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedAccessToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

/** base64url for Gmail's `raw` payload */
function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendSMS(body: string): Promise<void> {
  const accessToken = await getAccessToken();

  // T-Mobile gateway truncates ~160 chars per SMS but accepts long emails fine.
  // We send one message per chunk to avoid hidden carrier truncation.
  for (const chunk of splitMessage(body, 1500)) {
    // Build minimal RFC 822 message. Empty subject = SMS-only body on most gateways.
    const raw =
      `From: ${FROM_EMAIL}\r\n` +
      `To: ${TO_GATEWAY}\r\n` +
      `Subject: \r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `MIME-Version: 1.0\r\n` +
      `\r\n` +
      chunk;

    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: b64url(raw) }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Gmail send error:", err);
      throw new Error(`Gmail send ${res.status}: ${err}`);
    }
  }
}

function splitMessage(str: string, size: number): string[] {
  if (str.length <= size) return [str];
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}
