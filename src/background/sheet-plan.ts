import type { DOMContext, Message, PrimitiveResult, SheetPlan, SheetStep } from '../types/messages';

export interface SheetPlanDeps {
  fetchFn: typeof fetch;
  captureVisibleTab: () => Promise<string>;
  sendMessageToTab: (tabId: number, message: Message) => Promise<unknown>;
  workerUrl: string;
}

export type SheetPlanOutcome =
  | { status: 'plan'; plan: SheetPlan; sheetGid: string; spreadsheetId: string }
  | { status: 'advisor'; plan: SheetPlan }
  | { status: 'error'; error: string };

// Without a bound, a hung Claude/Anthropic call would mean TASK_COMPLETE never
// fires and the creature stays stuck on "thinking" forever.
const CHAT_TIMEOUT_MS = 30_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Screenshots are supplementary context for visual questions (chart layout,
// formatting colours, UI element locations) — not for formula/reference
// questions, which should rely on structured DOM context alone.
const VISUAL_REASONING_CUES = [
  'color', 'colour', 'chart', 'graph', 'format', 'formatting', 'look', 'looks',
  'appearance', 'highlight', 'highlighted', 'layout', 'icon', 'image', 'picture',
  'style', 'bold', 'italic', 'font', 'border', 'shape',
];

function needsScreenshot(text: string): boolean {
  const lower = text.toLowerCase();
  return VISUAL_REASONING_CUES.some(cue => lower.includes(cue));
}

// parseSheetPlan is deliberately domContext-agnostic — it only judges whether
// the worker's JSON is shaped like a plan. Sheet identity isn't its concern,
// so its 'plan' variant omits sheetGid/spreadsheetId; run() attaches those
// where domContext is actually in scope.
type ParsedPlan =
  | { status: 'plan'; plan: SheetPlan }
  | { status: 'advisor'; plan: SheetPlan };

// Only the worker's own advisor fallback ({totalSteps:0, summary, steps:[]}) is
// guaranteed valid JSON — valid-but-wrong-shaped responses (missing/malformed
// steps) still need to collapse to advisor mode here.
function parseSheetPlan(json: unknown): ParsedPlan {
  const advisorFallback = (summary: unknown): ParsedPlan => ({
    status: 'advisor',
    plan: {
      totalSteps: 0,
      summary: typeof summary === 'string' ? summary : "Sorry, I couldn't understand how to help with that.",
      steps: [],
    },
  });

  if (!isPlainObject(json) || typeof json.summary !== 'string') return advisorFallback(undefined);
  if (!Array.isArray(json.steps)) return advisorFallback(json.summary);

  const steps: SheetStep[] = [];
  for (const raw of json.steps) {
    if (
      !isPlainObject(raw) ||
      typeof raw.stepNumber !== 'number' ||
      typeof raw.description !== 'string' ||
      typeof raw.narration !== 'string' ||
      typeof raw.primitive !== 'string'
    ) {
      return advisorFallback(json.summary);
    }
    steps.push({
      stepNumber: raw.stepNumber,
      description: raw.description,
      narration: raw.narration,
      primitive: raw.primitive,
      // Args values aren't deep-validated — primitives already cast their own
      // args (see router.ts), so a wrong value type misbehaves rather than crashes.
      args: isPlainObject(raw.args) ? (raw.args as Record<string, string>) : {},
    });
  }

  if (steps.length === 0) return advisorFallback(json.summary);

  // totalSteps is normalized to steps.length rather than trusted from Claude's
  // own count — steps.length is the unambiguous ground truth.
  return { status: 'plan', plan: { totalSteps: steps.length, summary: json.summary, steps } };
}

// Owns the full lifecycle of one voice/text query: collect DOM context, capture
// a screenshot, call the worker, validate the response, and notify the tab when
// done — regardless of outcome. Deps are injected so this is unit-testable
// without Chrome APIs, mirroring dev-reload.ts's makeDevReloader pattern.
export function makeSheetPlanHandler(deps: SheetPlanDeps) {
  const { fetchFn, captureVisibleTab, sendMessageToTab, workerUrl } = deps;

  async function collectContext(tabId: number): Promise<DOMContext> {
    const res = (await sendMessageToTab(tabId, {
      type: 'RUN_PRIMITIVE',
      payload: { name: 'collectDOMContext' },
    })) as PrimitiveResult;
    if (!res?.ok) throw new Error(res?.error ?? 'collectDOMContext failed');
    return res.result as DOMContext;
  }

  async function run(tabId: number, text: string): Promise<SheetPlanOutcome> {
    let domContext: DOMContext;
    try {
      domContext = await collectContext(tabId);
    } catch (err) {
      // domContext is a required field the worker 400s without — no point calling /chat.
      return { status: 'error', error: `Could not read spreadsheet context: ${errMsg(err)}` };
    }

    // Only captured for visual-reasoning queries; non-fatal on failure either
    // way — proceed without a screenshot rather than lose the query.
    const screenshot = needsScreenshot(text)
      ? await captureVisibleTab().catch(() => undefined)
      : undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${workerUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, domContext, screenshot }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return { status: 'error', error: body?.error ?? `Worker responded with ${res.status}` };
      }

      const parsed = parseSheetPlan(await res.json());
      // Only 'plan' outcomes are ever executed against the DOM, so only they need
      // to carry which sheet the plan was built for — lets #21's executor guard
      // against the user switching sheets while the query was processing.
      return parsed.status === 'plan'
        ? { ...parsed, sheetGid: domContext.sheetGid, spreadsheetId: domContext.spreadsheetId }
        : parsed;
    } catch (err) {
      return { status: 'error', error: errMsg(err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return async function handleUserQuery(tabId: number, text: string): Promise<SheetPlanOutcome> {
    const outcome = await run(tabId, text);
    // A 'plan' outcome hands off to the execution engine, which owns TASK_STARTED/
    // TASK_COMPLETE for the run it's about to perform — sending TASK_COMPLETE here
    // too would flash the creature back to idle before execution even begins.
    // advisor/error outcomes have no further processing, so notify here instead,
    // even on error, so the creature doesn't stay stuck on "thinking" — tab may
    // have closed by now, so failures here are ignored.
    if (outcome.status !== 'plan') {
      await sendMessageToTab(tabId, { type: 'TASK_COMPLETE' }).catch(() => {});
    }
    return outcome;
  };
}
