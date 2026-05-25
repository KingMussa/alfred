import type { CalendarEvent } from "./types.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;
const ICLOUD_EMAIL = Deno.env.get("ICLOUD_EMAIL") ?? "";
const ICLOUD_APP_PASSWORD = Deno.env.get("ICLOUD_APP_PASSWORD") ?? "";

async function getGoogleToken(): Promise<string> {
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
  return data.access_token as string;
}

export async function getGoogleEvents(hoursAhead: number): Promise<CalendarEvent[]> {
  const token = await getGoogleToken();
  const now = new Date();
  const end = new Date(now.getTime() + hoursAhead * 3600 * 1000);

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
      `?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}` +
      `&singleEvents=true&orderBy=startTime&maxResults=20`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();

  return (data.items ?? []).map((item: Record<string, unknown>): CalendarEvent => {
    const start = item.start as Record<string, string>;
    const end = item.end as Record<string, string>;
    return {
      id: `google_${item.id as string}`,
      title: (item.summary as string) || "Untitled",
      start: new Date(start.dateTime ?? start.date),
      end: new Date(end.dateTime ?? end.date),
      location: item.location as string | undefined,
      calendar: "google",
    };
  });
}

// ---------------------------------------------------------------------------
// iCloud CalDAV
// ---------------------------------------------------------------------------

function toICalDate(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
}

function parseICalDate(s: string): Date {
  // Handles: 20231025T140000Z or 20231025T140000
  const clean = s.replace(/Z$/, "");
  return new Date(
    `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T` +
      `${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`,
  );
}

function parseICalEvents(xml: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const blocks = xml.matchAll(/<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/gi);

  for (const [, ical] of blocks) {
    const get = (key: string) => ical.match(new RegExp(`${key}(?:;[^:]+)?:([^\\r\\n]+)`))?.[1]?.trim();

    const dtStart = get("DTSTART");
    if (!dtStart) continue;

    events.push({
      id: `apple_${get("UID") ?? Math.random().toString(36).slice(2)}`,
      title: get("SUMMARY") ?? "Untitled",
      start: parseICalDate(dtStart),
      end: get("DTEND") ? parseICalDate(get("DTEND")!) : parseICalDate(dtStart),
      location: get("LOCATION"),
      calendar: "apple",
    });
  }
  return events;
}

async function getAppleEvents(hoursAhead: number): Promise<CalendarEvent[]> {
  if (!ICLOUD_EMAIL || !ICLOUD_APP_PASSWORD) return [];

  const auth = `Basic ${btoa(`${ICLOUD_EMAIL}:${ICLOUD_APP_PASSWORD}`)}`;
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: auth,
    "Content-Type": "application/xml; charset=utf-8",
    ...extra,
  });

  try {
    // Step 1: discover current-user-principal
    const step1 = await fetch("https://caldav.icloud.com/", {
      method: "PROPFIND",
      headers: headers({ Depth: "0" }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:">
  <A:prop><A:current-user-principal/></A:prop>
</A:propfind>`,
    });
    if (!step1.ok) return [];
    const xml1 = await step1.text();
    const principal = xml1.match(/<current-user-principal[\s\S]*?<href>([^<]+)<\/href>/i)?.[1];
    if (!principal) return [];

    // Step 2: get calendar-home-set
    const step2 = await fetch(`https://caldav.icloud.com${principal}`, {
      method: "PROPFIND",
      headers: headers({ Depth: "0" }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop><C:calendar-home-set/></A:prop>
</A:propfind>`,
    });
    if (!step2.ok) return [];
    const xml2 = await step2.text();
    const homeHref = xml2.match(/<calendar-home-set[\s\S]*?<href>([^<]+)<\/href>/i)?.[1];
    if (!homeHref) return [];

    // Step 3: list calendars under home
    const step3 = await fetch(`https://caldav.icloud.com${homeHref}`, {
      method: "PROPFIND",
      headers: headers({ Depth: "1" }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop><A:resourcetype/></A:prop>
</A:propfind>`,
    });
    if (!step3.ok) return [];
    const xml3 = await step3.text();

    // Keep only hrefs where <calendar/> resourcetype is present
    const calHrefs: string[] = [];
    for (const [, block] of xml3.matchAll(/<response>([\s\S]*?)<\/response>/gi)) {
      if (!/<calendar\s*\/>/.test(block)) continue;
      const href = block.match(/<href>([^<]+)<\/href>/)?.[1];
      if (href) calHrefs.push(href);
    }

    // Step 4: REPORT each calendar for events in the time window
    const now = new Date();
    const windowEnd = new Date(now.getTime() + hoursAhead * 3600 * 1000);
    const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${toICalDate(now)}" end="${toICalDate(windowEnd)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

    const events: CalendarEvent[] = [];
    for (const href of calHrefs.slice(0, 6)) {
      try {
        const r = await fetch(`https://caldav.icloud.com${href}`, {
          method: "REPORT",
          headers: headers({ Depth: "1" }),
          body: reportBody,
        });
        if (r.ok) events.push(...parseICalEvents(await r.text()));
      } catch {
        // skip individual calendar failures
      }
    }
    return events;
  } catch (e) {
    console.error("Apple Calendar error:", e);
    return [];
  }
}

export async function getUpcomingEvents(hoursAhead: number): Promise<CalendarEvent[]> {
  const [google, apple] = await Promise.all([
    getGoogleEvents(hoursAhead).catch(() => [] as CalendarEvent[]),
    getAppleEvents(hoursAhead).catch(() => [] as CalendarEvent[]),
  ]);
  return [...google, ...apple].sort((a, b) => a.start.getTime() - b.start.getTime());
}
