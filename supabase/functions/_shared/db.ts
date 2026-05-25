// Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY automatically at runtime.
const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const base = (table: string) => `${URL}/rest/v1/${table}`;
const authHeaders = {
  Authorization: `Bearer ${KEY}`,
  apikey: KEY,
  "Content-Type": "application/json",
};

async function get(table: string, query: string): Promise<unknown[]> {
  const res = await fetch(`${base(table)}?${query}&select=*`, { headers: authHeaders });
  return res.json();
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  await fetch(base(table), {
    method: "POST",
    headers: { ...authHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
}

export async function hasProcessedEmail(id: string): Promise<boolean> {
  const rows = await get("processed_emails", `message_id=eq.${encodeURIComponent(id)}`);
  return Array.isArray(rows) && rows.length > 0;
}

export async function markEmailProcessed(
  id: string,
  subject: string,
  sender: string,
  score: number,
  notified: boolean,
): Promise<void> {
  await insert("processed_emails", { message_id: id, subject, sender, importance_score: score, notified });
}

export async function hasReminderBeenSent(eventId: string, type: string): Promise<boolean> {
  const rows = await get(
    "calendar_reminders_sent",
    `event_id=eq.${encodeURIComponent(eventId)}&reminder_type=eq.${type}`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

export async function markReminderSent(eventId: string, type: string): Promise<void> {
  await insert("calendar_reminders_sent", { event_id: eventId, reminder_type: type });
}

export async function logSMS(message: string, type: string): Promise<void> {
  await insert("sms_log", { message, type });
}
