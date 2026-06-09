// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ vision.ts — Telegram image intake → Gemini Vision → structured data  ║
// ║                                                                       ║
// ║ Dave snaps a receipt / statement / paystub / IRS letter → Alfred      ║
// ║ classifies, extracts, takes the right action, replies with a clean   ║
// ║ summary. Auto-logs receipts as expenses; statements & paystubs are   ║
// ║ returned for Dave to confirm + apply via /asset, /debt, etc.         ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY"); // optional — enables high-quality blueprint reads
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

// Blueprints are dense and high-stakes — read them with Claude (Opus) instead of
// free Gemini when the key is present. Gated to blueprints only to control cost.
const CLAUDE_VISION_MODEL = "claude-opus-4-8";

const H = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };

// ── 1. Telegram getFile → download bytes ─────────────────────────────────────
export async function downloadTelegramFile(fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  // Step 1: ask Telegram where the file lives
  const metaRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  if (!metaRes.ok) throw new Error(`getFile failed ${metaRes.status}`);
  const meta = await metaRes.json() as { ok: boolean; result?: { file_path: string }; description?: string };
  if (!meta.ok || !meta.result?.file_path) throw new Error(`getFile: ${meta.description ?? "no file_path"}`);

  // Step 2: actually download it
  const binRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${meta.result.file_path}`);
  if (!binRes.ok) throw new Error(`file download ${binRes.status}`);
  const buf = await binRes.arrayBuffer();
  const path = meta.result.file_path.toLowerCase();
  const mime = path.endsWith(".png") ? "image/png"
    : path.endsWith(".webp") ? "image/webp"
    : path.endsWith(".pdf") ? "application/pdf"
    : path.endsWith(".oga") || path.endsWith(".ogg") || path.endsWith(".opus") ? "audio/ogg"
    : path.endsWith(".mp3") ? "audio/mpeg"
    : path.endsWith(".m4a") ? "audio/mp4"
    : path.endsWith(".wav") ? "audio/wav"
    : "image/jpeg";
  return { bytes: new Uint8Array(buf), mime };
}

// ── 2. Classify + extract via Gemini Vision ──────────────────────────────────
export type DocType =
  | "receipt"
  | "bank_statement"
  | "credit_card_statement"
  | "paystub"
  | "irs_letter"
  | "bill_invoice"
  | "check"
  | "id_document"
  | "blueprint"
  | "other";

export interface ClassifiedDoc {
  doc_type: DocType;
  confidence: number;            // 0..1
  summary: string;               // human-readable one-liner
  data: Record<string, unknown>; // shape depends on doc_type
  raw: string;                   // full model response
}

const CLASSIFICATION_PROMPT = `You are Alfred's vision classifier. Look at this image and identify the document type, then extract the structured fields.

Return ONLY valid JSON. No prose, no markdown. The shape:

{
  "doc_type": "<one of: receipt | bank_statement | credit_card_statement | paystub | irs_letter | bill_invoice | check | id_document | blueprint | other>",
  "confidence": <0..1>,
  "summary": "<one-line plain-English summary, e.g. 'Walmart grocery receipt $47.23 dated 2026-05-26'>",
  "data": { <fields specific to doc_type — see below> }
}

FIELD SHAPES BY DOC_TYPE:

receipt:
  { "vendor": "Walmart", "amount": 47.23, "date": "2026-05-26",
    "items_count": 12,
    "category_guess": "groceries|dining|gas|amazon|atm|casino|apple_cash|subscription|gear|other",
    "payment_method": "card_last4|cash|other" }

bank_statement:
  { "institution": "Navy Federal CU", "account_name": "EveryDay Checking",
    "account_last4": "0367", "period_start": "2026-05-01", "period_end": "2026-05-31",
    "beginning_balance": 1450.00, "ending_balance": 485.00,
    "deposits_total": 9200.00, "withdrawals_total": 10165.00,
    "transactions_count": 47 }

credit_card_statement:
  { "issuer": "Capital One", "account_last4": "1234",
    "statement_date": "2026-05-15", "balance": 1820.00,
    "min_payment": 35.00, "due_date": "2026-06-10",
    "credit_limit": 5000.00, "available_credit": 3180.00,
    "purchases_total": 850.00, "payments_total": 200.00,
    "interest_charged": 22.50, "apr": 24.99 }

paystub:
  { "employer": "ACCO Engineered Systems", "period_start": "2026-05-15",
    "period_end": "2026-05-21", "pay_date": "2026-05-26",
    "gross": 2450.00, "net": 1820.00,
    "fed_tax": 285.00, "state_tax": 45.00,
    "ss": 152.00, "medicare": 36.00,
    "union_dues": 35.00, "401k": 0, "health": 70.00,
    "ytd_gross": 41200.00, "ytd_net": 30900.00,
    "hours_regular": 40, "hours_ot": 0 }

irs_letter:
  { "letter_code": "CP14|CP504|LT11|etc",
    "issue_date": "2026-05-10",
    "balance_owed": 25000.00,
    "action_required": "respond by | pay by | call by",
    "deadline_date": "2026-06-09",
    "urgency": "critical|high|medium|low",
    "body_summary": "1-2 sentence summary of what the letter says" }

bill_invoice:
  { "vendor": "NV Energy", "amount": 87.42, "due_date": "2026-06-25",
    "account_number": "...", "service_period": "2026-04-15 to 2026-05-15" }

check:
  { "payer": "...", "payee": "...", "amount": 0, "date": "...", "memo": "..." }

id_document:
  { "kind": "drivers_license|passport|other",
    "redacted": true,
    "note": "We do NOT extract full PII — just acknowledge the document type." }

blueprint (a VRF refrigerant piping coordination drawing — Mitsubishi/Daikin City-Multi style. RL = refrigerant liquid line, RG = refrigerant gas line; BOI = bottom-of-insulation elevation; AFF = above finished floor; BC = branch controller; VRF/VCU/HPCU/HPAH = units; UP/DN = riser; TYP-n = repeats n times):
  { "sheet_number": "M-501", "title": "Level 3 VRF Piping Plan",
    "discipline": "mechanical / VRF refrigerant",
    "revision": "3", "scale": "1/4 in = 1 ft",
    "system": "Mitsubishi City Multi R2 (heat recovery) or similar",
    "grids": ["24","25","Column E"],
    "indoor_units":  [ { "tag": "VRF-46 1122-1", "type": "cassette | ducted | air handler", "aff": "8 ft 0 in" } ],
    "controllers":   [ { "tag": "BC-46", "type": "BC controller | CMY-Y202S-G2 branch joint", "aff": "13 ft 0 in" } ],
    "refrigerant_lines": [ { "kind": "RL | RG", "size": "3/8 in", "boi": "17 ft 10 3/4 in", "note": "TYP-2 | to VRF-39-1125-1" } ],
    "risers":      [ "UP TO VCU-46", "UP TO HPCU-01" ],
    "hangers":     [ "red field markups, e.g. 'Add Hanger near Column E', 'Center Hanger'" ],
    "dimensions":  [ "locating dims, e.g. '12 ft 0 5/8 in'" ],
    "field_notes": [ "handwritten markups, e.g. '3W 18-7 TOP / 18-0 BTM'" ],
    "ambiguities": [ "anything unreadable, cut off, or glare-washed" ] }

other:
  { "best_guess": "...", "key_text": "first 200 chars of text visible" }

If you can't read fields clearly, use null. If the image is blurry/unreadable, set doc_type=other with confidence < 0.3.

For blueprint: it's usually a phone photo of a much larger VRF sheet, so text may be small or partly cut off. Read every RL/RG line with its size + BOI, and every unit tag with its AFF. Use empty arrays [] for sections that aren't visible — never invent sizes, counts, or elevations. Put anything unreadable in "ambiguities". Still set doc_type=blueprint when it's clearly a piping/refrigerant drawing, even if you can only read the title block.

Output ONLY the JSON.`;

export async function classifyAndExtract(
  imageBytes: Uint8Array,
  mime: string,
  caption?: string,
): Promise<ClassifiedDoc> {
  const b64 = btoa(String.fromCharCode(...imageBytes));
  const captionLine = caption ? `\n\nUser caption (hint): "${caption}"` : "";

  const body = {
    contents: [{
      parts: [
        { text: CLASSIFICATION_PROMPT + captionLine },
        { inline_data: { mime_type: mime, data: b64 } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 2000,
      temperature: 0.1,
      responseMimeType: "application/json",
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
    throw new Error(`Gemini Vision ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text — possibly safety block");

  let parsed: ClassifiedDoc;
  try {
    const obj = JSON.parse(text);
    parsed = {
      doc_type: obj.doc_type ?? "other",
      confidence: Number(obj.confidence ?? 0.5),
      summary: obj.summary ?? "",
      data: obj.data ?? {},
      raw: text,
    };
  } catch (e) {
    throw new Error(`Could not parse Gemini JSON: ${e}. Raw: ${text.slice(0, 200)}`);
  }
  return parsed;
}

// ── 2b. High-quality blueprint read via Claude vision (Opus) ─────────────────
// VRF refrigerant sheets are dense and the callouts (RL/RG sizes, BOI elevations)
// are what a fitter actually needs. Gemini Flash misses too much on a wavy phone
// shot, so blueprints get read by Claude when ANTHROPIC_API_KEY is set.

const VRF_BLUEPRINT_PROMPT =
`You are a senior MEP detailer reading a VRF refrigerant piping coordination drawing
(Mitsubishi/Daikin City-Multi style), usually a jobsite phone photo of part of a larger sheet.

Decode this trade language:
- RL = refrigerant LIQUID line, RG = refrigerant GAS line (sizes like 1/4", 3/8", 1/2", 5/8", 7/8", 1 1/8")
- BOI = Bottom Of Insulation elevation (install height of the bottom of the insulated line)
- AFF = Above Finished Floor (unit mounting height)
- BC = Branch Controller; CMY-Y... = Mitsubishi branch / Y-joint
- VRF / VCU / HPCU / HPAH = indoor units, condensing units, heat-pump air handler
- "UP TO X" / UP-DN circles = risers up/down to a unit on another level
- TYP-n = the callout repeats at n identical locations
- purple bundles = the line-sets running together; numbers in circles / "Column E" = grid refs
- red text/arrows + "Add Hanger" / "Center Hanger" = field markups for pipe supports

Extract EVERYTHING you can read into this exact JSON shape (no prose, no markdown fences):

{ "confidence": <0..1>,
  "summary": "<one line, e.g. 'L3 VRF plan grids 24-25, BC-46/47 feeding cassettes 7-8ft AFF'>",
  "data": {
    "sheet_number": null, "title": null, "discipline": "VRF refrigerant",
    "revision": null, "scale": null, "system": null,
    "grids": [],
    "indoor_units":      [ { "tag": "", "type": "", "aff": "" } ],
    "controllers":       [ { "tag": "", "type": "", "aff": "" } ],
    "refrigerant_lines": [ { "kind": "RL|RG", "size": "", "boi": "", "note": "" } ],
    "risers": [], "hangers": [], "dimensions": [], "field_notes": [], "ambiguities": []
  } }

Rules: read every RL/RG line with its size and BOI. Capture every unit tag with its AFF.
Record red-pen hanger markups under "hangers" and any handwriting under "field_notes".
Use empty arrays / null where you genuinely can't read it — NEVER invent sizes, counts, or
elevations. Put glare / cutoff / unreadable spots in "ambiguities". Output ONLY the JSON object.`;

// btoa(String.fromCharCode(...bytes)) overflows the call stack on multi-MB photos;
// encode in 32 KB chunks.
function toB64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function parseJsonLoose(text: string): { confidence?: number; summary?: string; data?: Record<string, unknown> } {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

async function extractBlueprintWithClaude(bytes: Uint8Array, mime: string, caption?: string): Promise<ClassifiedDoc> {
  if (!ANTHROPIC_KEY) throw new Error("no ANTHROPIC_API_KEY");
  const media = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : "image/jpeg";
  const captionLine = caption ? `\n\nField caption from the fitter: "${caption}"` : "";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model:      CLAUDE_VISION_MODEL,
      max_tokens: 8000,
      thinking:      { type: "adaptive" },
      output_config: { effort: "high" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: VRF_BLUEPRINT_PROMPT + captionLine },
          { type: "image", source: { type: "base64", media_type: media, data: toB64(bytes) } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Claude vision ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const j = await res.json();
  const blocks: Array<{ type?: string; text?: string }> = Array.isArray(j?.content) ? j.content : [];
  const out = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  if (!out) throw new Error("Claude vision returned no text block");

  const obj = parseJsonLoose(out);
  return {
    doc_type:   "blueprint",
    confidence: Number(obj.confidence ?? 0.9),
    summary:    obj.summary ?? "",
    data:       (obj.data ?? {}) as Record<string, unknown>,
    raw:        out,
  };
}

const BP_HINT = /\b(blueprint|blue ?print|print|drawing|sheet|vrf|riser|iso|bp)\b/i;
function isBlueprintHint(caption?: string): boolean {
  return !!caption && BP_HINT.test(caption);
}

// Entry point for the webhook: Gemini classifies (cheap); if it's a blueprint
// (or Dave captioned it as one), re-read with Claude for the detailed VRF data.
export async function readDocument(bytes: Uint8Array, mime: string, caption?: string): Promise<ClassifiedDoc> {
  const gem = await classifyAndExtract(bytes, mime, caption);
  const wantBlueprint =
    (gem.doc_type === "blueprint" || isBlueprintHint(caption)) &&
    mime.startsWith("image/") && !!ANTHROPIC_KEY;
  if (!wantBlueprint) return gem;
  try {
    return await extractBlueprintWithClaude(bytes, mime, caption);
  } catch (e) {
    console.error("Claude blueprint upgrade failed, using Gemini result:", e);
    return gem.doc_type === "blueprint" ? gem : { ...gem, doc_type: "blueprint" };
  }
}

// ── 3. Save the document row ─────────────────────────────────────────────────
export async function saveDocument(input: {
  telegram_file_id: string;
  telegram_unique_id?: string;
  source: "telegram_photo" | "telegram_document";
  caption?: string;
  mime_type: string;
  bytes: number;
  classified: ClassifiedDoc;
  action_taken: string;
  action_ref?: string;
}): Promise<{ id: number }> {
  const r = await fetch(`${URL}/rest/v1/documents`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({
      telegram_file_id:   input.telegram_file_id,
      telegram_unique_id: input.telegram_unique_id ?? null,
      source:             input.source,
      caption:            input.caption ?? null,
      mime_type:          input.mime_type,
      bytes:              input.bytes,
      doc_type:           input.classified.doc_type,
      confidence:         input.classified.confidence,
      summary:            input.classified.summary,
      extracted_data:     input.classified.data,
      raw_response:       input.classified.raw,
      action_taken:       input.action_taken,
      action_ref:         input.action_ref ?? null,
    }),
  });
  if (!r.ok) throw new Error(`save document ${r.status}: ${await r.text()}`);
  const rows = await r.json() as Array<{ id: number }>;
  return rows[0];
}

// ── 4. Auto-action per doc type ──────────────────────────────────────────────
export interface ActionResult {
  action_taken: string;
  action_ref?: string;
  reply: string;
}

export async function actOnClassified(c: ClassifiedDoc): Promise<ActionResult> {
  switch (c.doc_type) {
    case "receipt":    return actReceipt(c);
    case "bank_statement":
    case "credit_card_statement":
                       return actStatement(c);
    case "paystub":    return actPaystub(c);
    case "irs_letter": return actIrsLetter(c);
    case "bill_invoice": return actBill(c);
    case "blueprint":  return actBlueprint(c);
    case "id_document": return {
      action_taken: "noop",
      reply: "🪪 ID doc detected. I'm not storing PII — message ignored.",
    };
    default:           return {
      action_taken: "captured",
      reply: `📄 Doc detected but I can't auto-classify it (${(c.confidence * 100).toFixed(0)}% conf). Saved for review.\n\n${c.summary}`,
    };
  }
}

async function actReceipt(c: ClassifiedDoc): Promise<ActionResult> {
  const d = c.data as { vendor?: string; amount?: number; date?: string; category_guess?: string; items_count?: number };
  if (!d.amount || d.amount <= 0) {
    return { action_taken: "captured", reply: `🧾 Receipt detected but no amount read. Saved for review.\n${c.summary}` };
  }
  const category = mapCategory(d.category_guess);
  const note = `${d.vendor ?? "unknown"}${d.items_count ? ` · ${d.items_count} items` : ""}`;
  const r = await fetch(`${URL}/rest/v1/expenses`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({
      amount: d.amount,
      category,
      note,
      spent_at: d.date ?? new Date().toISOString().slice(0, 10),
    }),
  });
  const expRows = await r.json() as Array<{ id: number }>;
  return {
    action_taken: "logged_expense",
    action_ref: `expenses:${expRows[0].id}`,
    reply: `🧾 LOGGED: $${d.amount.toFixed(2)} ${category}\n${note}${d.date ? ` · ${d.date}` : ""}\n\nCheck /spending to see month-to-date.`,
  };
}

async function actStatement(c: ClassifiedDoc): Promise<ActionResult> {
  const d = c.data as {
    institution?: string; account_name?: string; account_last4?: string;
    ending_balance?: number; balance?: number; period_end?: string;
  };
  const bal = d.ending_balance ?? d.balance;
  const acctLine = [d.institution, d.account_name, d.account_last4 ? `…${d.account_last4}` : null].filter(Boolean).join(" ");
  if (bal === undefined) {
    return { action_taken: "captured", reply: `🏦 Statement read but no balance extracted. Saved.\n${c.summary}` };
  }
  return {
    action_taken: "captured",
    reply: [
      `🏦 STATEMENT EXTRACTED`,
      acctLine,
      `Balance: $${bal.toLocaleString()}`,
      d.period_end ? `As of: ${d.period_end}` : "",
      ``,
      `To apply: /assets (find id), then /asset <id> ${bal}`,
      `Or /debts + /debt <id> ${bal} if this is a credit card.`,
    ].filter(Boolean).join("\n"),
  };
}

async function actPaystub(c: ClassifiedDoc): Promise<ActionResult> {
  const d = c.data as { employer?: string; gross?: number; net?: number; pay_date?: string; ytd_gross?: number };
  // No income table yet — save as a capture and return summary
  const body = [
    `Paystub: ${d.employer ?? "?"}`,
    d.gross  ? `Gross $${d.gross.toLocaleString()}` : "",
    d.net    ? `Net $${d.net.toLocaleString()}`     : "",
    d.pay_date ? `Pay ${d.pay_date}` : "",
    d.ytd_gross ? `YTD gross $${d.ytd_gross.toLocaleString()}` : "",
  ].filter(Boolean).join(" · ");
  const r = await fetch(`${URL}/rest/v1/captures`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ kind: "note", body, tags: ["paystub", "income"] }),
  });
  const rows = await r.json() as Array<{ id: number }>;
  return {
    action_taken: "captured",
    action_ref: `captures:${rows[0].id}`,
    reply: `💵 PAYSTUB\n${body}\n\nSaved to captures. (Income table coming in v6.)`,
  };
}

async function actIrsLetter(c: ClassifiedDoc): Promise<ActionResult> {
  const d = c.data as {
    letter_code?: string; balance_owed?: number; action_required?: string;
    deadline_date?: string; urgency?: string; body_summary?: string;
  };
  const urgencyIcon = d.urgency === "critical" ? "🚨🚨" : d.urgency === "high" ? "🚨" : "⚠️";
  const body = [
    `${urgencyIcon} IRS LETTER ${d.letter_code ?? ""}`,
    d.balance_owed ? `Balance: $${d.balance_owed.toLocaleString()}` : "",
    d.deadline_date ? `Deadline: ${d.deadline_date}` : "",
    d.action_required ? `Action: ${d.action_required}` : "",
    d.body_summary ? `\n${d.body_summary}` : "",
  ].filter(Boolean).join("\n");
  const r = await fetch(`${URL}/rest/v1/captures`, {
    method: "POST",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ kind: "todo", body: `IRS: ${d.action_required ?? d.body_summary ?? "review letter"}`, tags: ["irs", "urgent"] }),
  });
  const rows = await r.json() as Array<{ id: number }>;
  return {
    action_taken: "flagged",
    action_ref: `captures:${rows[0].id}`,
    reply: body + `\n\nTodo #${rows[0].id} created. Use /todos to see.`,
  };
}

async function actBill(c: ClassifiedDoc): Promise<ActionResult> {
  const d = c.data as { vendor?: string; amount?: number; due_date?: string };
  return {
    action_taken: "captured",
    reply: [
      `💸 BILL DETECTED`,
      `${d.vendor ?? "?"} — $${d.amount ?? "?"} due ${d.due_date ?? "?"}`,
      ``,
      `If this is a NEW recurring bill, add via SQL or ask me on the laptop. If it's an existing one, just pay it.`,
    ].join("\n"),
  };
}

interface BlueprintData {
  sheet_number?: string; title?: string; discipline?: string;
  revision?: string; scale?: string; system?: string;
  grids?: string[];
  indoor_units?: Array<{ tag?: string; type?: string; aff?: string }>;
  controllers?:  Array<{ tag?: string; type?: string; aff?: string }>;
  refrigerant_lines?: Array<{ kind?: string; size?: string; boi?: string; note?: string }>;
  risers?: string[];
  hangers?: string[];
  dimensions?: string[];
  field_notes?: string[];
  ambiguities?: string[];
}

async function actBlueprint(c: ClassifiedDoc): Promise<ActionResult> {
  const d = c.data as BlueprintData;
  const L: string[] = [];

  // Title block
  L.push(["📐 BLUEPRINT", d.sheet_number, d.revision ? `Rev ${d.revision}` : ""].filter(Boolean).join(" ") + " — VRF Refrigerant");
  const sub = [d.title, d.scale ? `Scale ${d.scale}` : ""].filter(Boolean).join(" · ");
  if (sub) L.push(sub);
  if (d.system) L.push(d.system);
  if (d.grids?.length) L.push(`Grids: ${d.grids.join(", ")}`);

  // Refrigerant lines — the heart of the sheet: size + RL/RG + BOI elevation
  if (d.refrigerant_lines?.length) {
    L.push("", `REFRIGERANT LINES (${d.refrigerant_lines.length})`);
    for (const r of d.refrigerant_lines.slice(0, 24)) {
      const head = [r.size, r.kind].filter(Boolean).join(" ");
      L.push(`• ${head}${r.boi ? `  BOI ${r.boi}` : ""}${r.note ? `  (${r.note})` : ""}`);
    }
  }
  if (d.indoor_units?.length) {
    L.push("", "INDOOR UNITS");
    for (const u of d.indoor_units.slice(0, 18)) {
      L.push(`• ${[u.tag, u.type].filter(Boolean).join(" ")}${u.aff ? ` @ ${u.aff} AFF` : ""}`);
    }
  }
  if (d.controllers?.length) {
    L.push("", "CONTROLLERS / JOINTS");
    for (const b of d.controllers.slice(0, 12)) {
      L.push(`• ${[b.tag, b.type].filter(Boolean).join(" — ")}${b.aff ? ` @ ${b.aff} AFF` : ""}`);
    }
  }
  if (d.risers?.length) {
    L.push("", "RISERS");
    for (const r of d.risers.slice(0, 10)) L.push(`• ${r}`);
  }
  if (d.hangers?.length) {
    L.push("", "🔩 HANGERS (field markups)");
    for (const h of d.hangers.slice(0, 10)) L.push(`• ${h}`);
  }
  if (d.field_notes?.length) {
    L.push("", "✍️ FIELD NOTES");
    for (const n of d.field_notes.slice(0, 8)) L.push(`• ${n}`);
  }
  if (d.dimensions?.length) L.push("", `DIMS: ${d.dimensions.slice(0, 8).join(" · ")}`);

  if (d.ambiguities?.length) {
    L.push("", "❓ Couldn't read clearly:");
    for (const a of d.ambiguities.slice(0, 5)) L.push(`• ${a}`);
    L.push("(send as a FILE, not a photo + shoot flat/lit = better read)");
  }

  const hasContent = d.refrigerant_lines?.length || d.indoor_units?.length || d.controllers?.length;
  if (!hasContent && !d.sheet_number) {
    return {
      action_taken: "captured",
      reply: `📐 Looks like a print, but I couldn't pull much off it.\n${c.summary}\n\nSend it as a FILE (not a photo) and shoot one area flat + lit.`,
    };
  }

  L.push("", "Saved — pull it up with /blueprints");
  return { action_taken: "captured", reply: L.join("\n") };
}

function mapCategory(guess?: string): string {
  const m: Record<string, string> = {
    groceries: "groceries", grocery: "groceries",
    dining: "dining", restaurant: "dining", food: "dining",
    gas: "gas", fuel: "gas",
    amazon: "amazon", online: "amazon",
    atm: "atm", cash: "atm",
    casino: "casino", gambling: "casino",
    apple_cash: "apple_cash", zelle: "apple_cash", venmo: "apple_cash",
    subscription: "subscription", recurring: "subscription",
    gear: "gear", tools: "gear",
  };
  if (!guess) return "other";
  return m[guess.toLowerCase()] ?? "other";
}
