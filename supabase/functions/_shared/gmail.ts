import type { Email } from "./types.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;

async function getAccessToken(): Promise<string> {
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
  const data = await res.json();
  if (!data.access_token) throw new Error(`Gmail token error: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

export async function getNewEmails(sinceMinutes: number): Promise<Email[]> {
  const token = await getAccessToken();
  const afterTs = Math.floor((Date.now() - sinceMinutes * 60 * 1000) / 1000);

  // Exclude promotions and social so only real emails surface
  const q = `after:${afterTs} -category:promotions -category:social -category:updates`;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=15`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const listData = await listRes.json();
  if (!listData.messages?.length) return [];

  const emails: Email[] = [];
  for (const msg of listData.messages.slice(0, 12)) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}` +
          `?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const d = await msgRes.json();
      const h = (name: string) =>
        d.payload?.headers?.find((x: { name: string; value: string }) => x.name === name)?.value ?? "";

      emails.push({
        id: msg.id,
        subject: h("Subject") || "(no subject)",
        sender: h("From"),
        snippet: d.snippet ?? "",
        receivedAt: new Date(Number(d.internalDate)),
      });
    } catch {
      // skip malformed messages
    }
  }
  return emails;
}

export async function getTodaysEmails(): Promise<Email[]> {
  return getNewEmails(24 * 60);
}
