// AI wrapper — uses Google Gemini (free tier).
// Get a key at https://aistudio.google.com/apikey — no payment method required.

const API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const MODEL = "gemini-2.5-flash"; // free-tier eligible (2.0-flash was dropped from free tier 2026), fast, smart enough for ranking/summary
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

/**
 * Send a prompt to Gemini and return the text response.
 * Includes a single retry on 429 (rate limit) with a short backoff.
 */
export async function aiChat(prompt: string, maxTokens = 500): Promise<string> {
  // Gemini 2.5 Flash uses "thinking tokens" that count against maxOutputTokens.
  // Disable thinking (thinkingBudget: 0) so the full budget goes to the actual response —
  // otherwise long prompts like the morning briefing get truncated.
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.4,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    if (res.status === 429) {
      // Rate limit — back off ~5s and try once more
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`Gemini returned no text. Raw: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return text;
  }

  throw new Error("Gemini API rate-limited twice in a row — giving up.");
}
