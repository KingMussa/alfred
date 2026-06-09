// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ voice.ts — Telegram voice note → Gemini transcription → text          ║
// ║                                                                       ║
// ║ Dave is on a ladder, hands busy, can't type. He taps the mic, talks,  ║
// ║ and Alfred turns it into text — which then flows through the exact     ║
// ║ same command router as a typed message. "todo call the inspector" or  ║
// ║ "note the 4-inch line on level 3 is capped" just works.               ║
// ║                                                                       ║
// ║ Uses the existing GEMINI_API_KEY (no new secret) and reuses           ║
// ║ vision.ts's Telegram downloader (now audio-aware).                    ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { downloadTelegramFile } from "./vision.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;

// Sentinel the model returns for silence / garbled audio.
export const UNINTELLIGIBLE = "[unintelligible]";

const TRANSCRIBE_PROMPT =
  `You are Alfred's voice transcriber. Transcribe the spoken audio to text, verbatim, in English. ` +
  `Return ONLY the transcript — no quotes, no labels, no commentary, no markdown. ` +
  `Write numbers as digits (e.g. "47 dollars" not "forty-seven dollars"). ` +
  `If the audio is silent, empty, or unintelligible, return exactly: ${UNINTELLIGIBLE}`;

// btoa(String.fromCharCode(...bytes)) blows the call stack on long clips —
// encode in 32 KB chunks so a 2-minute voice note doesn't crash the function.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface Transcription {
  transcript: string; // trimmed text, or UNINTELLIGIBLE
  mime: string;
  bytes: number;
}

export async function transcribeVoice(fileId: string): Promise<Transcription> {
  const { bytes, mime } = await downloadTelegramFile(fileId);
  const audioMime = mime.startsWith("audio/") ? mime : "audio/ogg"; // Telegram voice = .oga/Opus

  const body = {
    contents: [{
      parts: [
        { text: TRANSCRIBE_PROMPT },
        { inline_data: { mime_type: audioMime, data: toBase64(bytes) } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Gemini transcription ${r.status}: ${err.slice(0, 200)}`);
  }

  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Gemini returned no transcript — possibly a safety block or empty audio");
  }

  return { transcript: text.trim(), mime: audioMime, bytes: bytes.length };
}
