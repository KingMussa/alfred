import type { NewsItem } from "./types.ts";

const FEEDS = [
  { url: "https://feeds.bbci.co.uk/news/rss.xml", source: "BBC News" },
  { url: "https://feeds.npr.org/1001/rss.xml", source: "NPR" },
];

function extractText(raw: string): string {
  return raw.replace(/<!\[CDATA\[(.+?)\]\]>/s, "$1").replace(/<[^>]+>/g, "").trim();
}

async function parseFeed(url: string, source: string, count: number): Promise<NewsItem[]> {
  const res = await fetch(url, { headers: { "User-Agent": "DaveAssistant/1.0" } });
  if (!res.ok) return [];
  const xml = await res.text();

  const items: NewsItem[] = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const title = extractText(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const desc = extractText(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "");
    if (title) items.push({ title, description: desc.slice(0, 120), source });
    if (items.length >= count) break;
  }
  return items;
}

export async function getTopNews(count = 5): Promise<NewsItem[]> {
  try {
    const perFeed = Math.ceil(count / FEEDS.length);
    const results = await Promise.all(FEEDS.map((f) => parseFeed(f.url, f.source, perFeed)));
    return results.flat().slice(0, count);
  } catch (e) {
    console.error("News fetch error:", e);
    return [];
  }
}
