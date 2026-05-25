export interface Email {
  id: string;
  subject: string;
  sender: string;
  snippet: string;
  receivedAt: Date;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  calendar: "google" | "apple";
}

export interface NewsItem {
  title: string;
  description: string;
  source: string;
}
