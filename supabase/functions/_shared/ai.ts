// AI wrapper — Claude Haiku (primary) with Gemini 2.5 Flash fallback.
// Set ANTHROPIC_API_KEY in Supabase secrets to use Claude.
// If absent, falls back to Gemini free tier automatically.

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const GEMINI_KEY    = Deno.env.get("GEMINI_API_KEY")!;

/**
 * Send a prompt to the best available AI and return the text response.
 * Claude Haiku if ANTHROPIC_API_KEY is set, Gemini 2.5 Flash otherwise.
 */
export async function aiChat(prompt: string, maxTokens = 500): Promise<string> {
  return ANTHROPIC_KEY
    ? claudeChat(prompt, maxTokens)
    : geminiChat(prompt, maxTokens);
}

// ── Claude Haiku — fast, cheap (~$0.25/1M input tokens) ─────────────────────
async function claudeChat(prompt: string, maxTokens: number): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         ANTHROPIC_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5",
        max_tokens: maxTokens,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (res.status === 529 || res.status === 529) {
      // Overloaded — brief backoff
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`Claude returned no text. Raw: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return text;
  }

  throw new Error("Claude API unavailable after retry — falling through to Gemini.");
}

// ── Gemini 2.5 Flash — free tier fallback ───────────────────────────────────
async function geminiChat(prompt: string, maxTokens: number): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  // Gemini 2.5 Flash uses "thinking tokens" that count against maxOutputTokens.
  // Disable thinking (thinkingBudget: 0) so the full budget goes to the actual response.
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature:     0.4,
      thinkingConfig:  { thinkingBudget: 0 },
    },
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    if (res.status === 429) {
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
