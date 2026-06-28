import { buildUserMessage, type DOMContext } from './utils';

export interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ASSEMBLYAI_API_KEY: string;
  ELEVENLABS_VOICE_ID?: string; // defaults to George voice
}

// ----- CORS -----

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function withCors(response: Response): Response {
  const res = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

function errorResponse(message: string, status = 500): Response {
  return withCors(
    Response.json({ error: message }, { status }),
  );
}

// ----- Types -----

interface ChatRequestBody {
  text: string;
  domContext: DOMContext;
  screenshot?: string; // base64, only for visual questions
}

interface TTSRequestBody {
  text: string;
}

// ----- System prompt -----

const SYSTEM_PROMPT = `You are SheetBuddy, an AI assistant embedded directly inside Google Sheets as a Chrome extension. You can read live spreadsheet context and execute actions in the sheet on the user's behalf.

## Your response format
Always respond with a single valid JSON object — no markdown, no code fences, no prose. Two valid shapes:

**Action plan** (when you will take steps in the sheet):
{
  "totalSteps": <number>,
  "summary": "<one sentence spoken aloud before execution begins>",
  "steps": [
    {
      "stepNumber": <number>,
      "description": "<plain English for the playback log>",
      "narration": "<conversational sentence spoken aloud as this step runs>",
      "primitive": "<primitive name>",
      "args": { "<key>": "<value>" }
    }
  ]
}

**Advisor response** (when the question needs an explanation, not sheet actions):
{
  "totalSteps": 0,
  "summary": "<your full conversational answer here>",
  "steps": []
}

## Context priority
1. Use the structured DOM context (active cell, formula bar, column headers, sheet names) as your primary source of truth for writing formulas and referencing ranges.
2. Use the screenshot only for visual questions — chart layout, conditional formatting colours, UI element locations.
3. Never guess cell references or column names — derive them from the provided context.

## Available primitives
| primitive         | args                          | notes |
|-------------------|-------------------------------|-------|
| selectCell        | { ref: "B7" }                 | Always navigate before entering edit mode |
| enterEditMode     | {}                            | Opens the cell for editing |
| typeText          | { text: "=SUMIF(...)" }       | Types character by character |
| commitCell        | {}                            | Presses Enter to commit |
| pressEscape       | {}                            | Cancels edit or dismisses dialog |
| navigateToSheet   | { name: "Sheet2" }            | Switches to a sheet tab |
| openMenu          | { name: "Format" }            | Opens a top-level menu (teach mode) |
| clickMenuItem     | { text: "Bold" }              | Clicks a menu item by text (teach mode) |
| executeMenuItem   | { text: "Bold" }              | Executes via Alt+/ search (fastest menu path) |
| dispatchShortcut  | { id: "bold" }                | Dispatches OS-aware keyboard shortcut |

Shortcut IDs: bold, italic, underline, strikethrough, undo, redo, copy, paste, cut, selectAll.

## Mode selection
Detect the user's intent and choose the appropriate execution mode:

**Teach mode** — user says "how do I...", "show me where...", "walk me through...":
→ Use openMenu + clickMenuItem so the user sees where things live in the UI.
→ Narration: "I'm opening the Format menu — this is where text formatting lives."

**Action mode** — user says "do this", "apply...", "make it...", or just describes an end result:
→ Use dispatchShortcut when a shortcut exists. After executing, tell the user the shortcut.
→ Narration: "I've bolded the selection — the shortcut for this is Cmd+B on Mac."
→ If no shortcut exists for the operation, fall back to executeMenuItem and explain why.

## Formula writing rules
- Navigate to the target cell with selectCell before entering edit mode.
- Use actual column headers and data from the DOM context — never invent references.
- Prefer native Google Sheets formulas: SUMIF, VLOOKUP, INDEX/MATCH, etc.
- When the task is better served by Google's =AI(prompt, range) formula (bulk text generation, classification, summarisation row-by-row), type that formula instead and explain the choice.
- After writing a formula, offer to fill it down: end the summary with "Want me to apply this to the whole column?"

## Graceful fallback for =AI()
If you use =AI() and the narration should mention it might show #NAME? on some accounts, say: "If you see #NAME? here, your Google account may not have this feature enabled — just let me know and I'll use a different approach."

## Important constraints
- Never include passwords, API keys, or personal data in any step.
- Never delete data without an explicit destructive confirmation step with a clear warning narration.
- If the request is ambiguous about which cell or range, ask in the summary (totalSteps: 0) rather than guessing.`;

// ----- Route: POST /chat -----

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = await request.json() as ChatRequestBody;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { text, domContext, screenshot } = body;
  if (!text || !domContext) {
    return errorResponse('Missing required fields: text, domContext', 400);
  }

  const userMessage = buildUserMessage(text, domContext);

  type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

  const content: ContentBlock[] = [];
  if (screenshot) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshot },
    });
  }
  content.push({ type: 'text', text: userMessage });

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text();
    console.error('[SheetBuddy] Anthropic error:', err);
    return errorResponse('Claude API error', anthropicRes.status);
  }

  const anthropicData = await anthropicRes.json() as {
    content: Array<{ type: string; text: string }>;
  };
  const rawText = anthropicData.content.find(b => b.type === 'text')?.text ?? '';

  let plan: unknown;
  try {
    plan = JSON.parse(rawText);
  } catch {
    // Advisor fallback — Claude returned prose instead of JSON
    plan = { totalSteps: 0, summary: rawText, steps: [] };
  }

  return withCors(Response.json(plan));
}

// ----- Route: POST /tts -----

// Default: ElevenLabs "George" — clear, authoritative, conversational
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

async function handleTTS(request: Request, env: Env): Promise<Response> {
  let body: TTSRequestBody;
  try {
    body = await request.json() as TTSRequestBody;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { text } = body;
  if (!text) return errorResponse('Missing required field: text', 400);

  const voiceId = env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;

  const elevenRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'content-type': 'application/json',
        'accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );

  if (!elevenRes.ok) {
    const err = await elevenRes.text();
    console.error('[SheetBuddy] ElevenLabs error:', err);
    return errorResponse('TTS API error', elevenRes.status);
  }

  return new Response(elevenRes.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
    },
  });
}

// ----- Route: POST /transcribe-token -----

async function handleTranscribeToken(_request: Request, env: Env): Promise<Response> {
  const aaiRes = await fetch('https://api.assemblyai.com/v2/realtime/token', {
    method: 'POST',
    headers: {
      'authorization': env.ASSEMBLYAI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expires_in: 3600 }),
  });

  if (!aaiRes.ok) {
    const err = await aaiRes.text();
    console.error('[SheetBuddy] AssemblyAI error:', err);
    return errorResponse('AssemblyAI token error', aaiRes.status);
  }

  const data = await aaiRes.json() as { token: string };
  return withCors(Response.json({ token: data.token }));
}

// ----- Main fetch handler -----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsPreflightResponse();

    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return errorResponse('Method not allowed', 405);
    }

    switch (url.pathname) {
      case '/chat':             return handleChat(request, env);
      case '/tts':              return handleTTS(request, env);
      case '/transcribe-token': return handleTranscribeToken(request, env);
      default:                  return errorResponse('Not found', 404);
    }
  },
} satisfies ExportedHandler<Env>;
