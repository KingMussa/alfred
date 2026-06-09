// AI wrapper — Claude Haiku 4.5 (primary) with Gemini 2.5 Flash fallback.
// Set ANTHROPIC_API_KEY in Supabase secrets to use Claude.
// If Claude is unset OR fails after retries, falls back to Gemini automatically.

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const GEMINI_KEY    = Deno.env.get("GEMINI_API_KEY");

// Anthropic statuses worth retrying (rate limit / server / overloaded).
const RETRYABLE = new Set([429, 500, 529]);

/**
 * Send a prompt to the best available AI and return the text response.
 * Tries Claude Haiku 4.5 if ANTHROPIC_API_KEY is set; if that call fails
 * (after its own retries), falls through to Gemini 2.5 Flash. If no Claude
 * key is set, goes straight to Gemini.
 */
export async function aiChat(prompt: string, maxTokens = 500): Promise<string> {
  if (ANTHROPIC_KEY) {
    try {
      return await claudeChat(prompt, maxTokens);
    } catch (err) {
      // Real fallback: Claude is down/overloaded — try Gemini before giving up.
      console.error(`Claude unavailable, falling back to Gemini: ${err}`);
    }
  }
  return geminiChat(prompt, maxTokens);
}

// ── Claude Haiku 4.5 — fast, cheap ($1/1M input, $5/1M output) ──────────────
async function claudeChat(prompt: string, maxTokens: number): Promise<string> {
  let lastErr = "unknown error";

  for (let attempt = 0; attempt < 3; attempt++) {
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

    if (RETRYABLE.has(res.status)) {
      // Overloaded / rate-limited / server error — back off and retry.
      lastErr = `HTTP ${res.status} (retryable)`;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 1s, 2s, 4s
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

  throw new Error(`Claude API unavailable after 3 attempts — ${lastErr}`);
}

// ── Gemini 2.5 Flash — free tier fallback ───────────────────────────────────
async function geminiChat(prompt: string, maxTokens: number): Promise<string> {
  if (!GEMINI_KEY) {
    throw new Error("aiChat failed: Claude unavailable and no GEMINI_API_KEY set for fallback.");
  }

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
