// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ storage.ts — durable archive of captured images/PDFs in Supabase       ║
// ║ Storage. The vision pipeline extracts the data, but the original sheet ║
// ║ is what Dave wants to re-view later (/bp <id>), so we keep the bytes.  ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "alfred-docs";

export function extForMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("pdf")) return "pdf";
  return "jpg";
}

// Upload bytes to the private bucket. Returns the stored path.
export async function uploadDoc(path: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const res = await fetch(`${URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return path;
}

// Time-limited signed URL so Telegram can fetch a private object to re-send it.
export async function signedUrl(path: string, expiresSec = 3600): Promise<string> {
  const res = await fetch(`${URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: expiresSec }),
  });
  if (!res.ok) throw new Error(`storage sign ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { signedURL?: string };
  if (!j.signedURL) throw new Error("storage sign: no signedURL in response");
  return `${URL}/storage/v1${j.signedURL}`;
}
