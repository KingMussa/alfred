// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ compress.ts — shrink big jobsite photos before vision + storage.       ║
// ║                                                                       ║
// ║ A full-res blueprint FILE can be 5-12 MB. That's slow to read, costs   ║
// ║ more Claude tokens, and can blow past Anthropic's ~5 MB-per-image      ║
// ║ limit (which would silently drop the print back to the weaker Gemini   ║
// ║ read). We resize the long edge to 2560 px — the most Claude Opus       ║
// ║ actually uses for vision, so no usable detail is lost — and re-encode  ║
// ║ JPEG. Non-fatal: any failure returns the original bytes untouched.     ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const MAX_EDGE   = 2560;     // long-edge cap — Opus reads up to ~2576px; keeps fine BOI text
const SKIP_UNDER = 700_000;  // already small (e.g. a Telegram-compressed photo) — don't bother
const JPEG_Q     = 82;

export interface Compressed {
  bytes: Uint8Array;
  mime: string;
  resized: boolean;          // true if we actually shrank it (for logging)
  fromBytes: number;
}

export async function compressImage(bytes: Uint8Array, mime: string): Promise<Compressed> {
  const passthrough: Compressed = { bytes, mime, resized: false, fromBytes: bytes.length };

  // Only raster images. PDFs (document blocks) and GIFs pass through untouched.
  if (!mime.startsWith("image/") || mime.includes("gif")) return passthrough;
  if (bytes.length < SKIP_UNDER) return passthrough;

  try {
    const img = await Image.decode(bytes); // auto-detects JPEG / PNG
    const longEdge = Math.max(img.width, img.height);
    if (longEdge > MAX_EDGE) {
      if (img.width >= img.height) img.resize(MAX_EDGE, Image.RESIZE_AUTO);
      else                         img.resize(Image.RESIZE_AUTO, MAX_EDGE);
    }
    const out = await img.encodeJPEG(JPEG_Q);
    // Only adopt the result if it actually saved space.
    if (out.length < bytes.length) {
      return { bytes: out, mime: "image/jpeg", resized: true, fromBytes: bytes.length };
    }
    return passthrough;
  } catch (e) {
    console.error("compressImage failed (using original):", e);
    return passthrough;
  }
}
