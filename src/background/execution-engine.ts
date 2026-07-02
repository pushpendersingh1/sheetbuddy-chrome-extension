import type { CellRect, Message, PrimitiveResult, SheetStep } from '../types/messages';
import type { SheetPlanOutcome } from './sheet-plan';
import type { Narrator } from '../offscreen/narrator';

export const MockNarrator: Narrator = {
  speak(text: string): Promise<void> {
    console.log(`[SheetBuddy] ${text}`);
    return Promise.resolve();
  },
};

type PlanOutcome = Extract<SheetPlanOutcome, { status: 'plan' }>;

export interface ExecutionEngineDeps {
  sendMessageToTab: (tabId: number, message: Message) => Promise<unknown>;
  narrator: Narrator;
  pollIntervalMs?: number;
  confirmTimeoutMs?: number;
}

export type ExecutionResult =
  | { status: 'completed' }
  | { status: 'aborted' }
  | { status: 'stale-sheet' };

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_CONFIRM_TIMEOUT_MS = 2000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Maps a SheetStep's named args (as the worker's prompt teaches Claude to produce,
// e.g. { ref: "B7" }) onto the positional argument list router.ts's PRIMITIVES
// registry actually expects (see worker/src/index.ts's "Available primitives"
// table for the canonical key names).
const PRIMITIVE_ARG_KEYS: Record<string, string[]> = {
  selectCell: ['ref'],
  selectRange: ['start', 'end'],
  navigateToSheet: ['name'],
  typeText: ['text'],
  writeToSelectedCell: ['text'],
  dispatchShortcut: ['id'],
};

function toPositionalArgs(primitive: string, args: Record<string, string>): unknown[] {
  const keys = PRIMITIVE_ARG_KEYS[primitive];
  if (!keys) return [];
  return keys.map((key) => args[key]);
}

// Maps a step's primitive to the content-script primitive that reads back its
// on-screen rect for the SheetBuddy cursor, once the primitive's own effect has
// landed and been confirmed. Google Sheets renders its grid on a single canvas —
// there is no per-cell DOM element, so the cursor can only move to reflect a
// selection that has already landed (see readActiveCellRect/readSelectionRect in
// src/content/primitives.ts), not "before" the very primitive that creates it.
// Primitives with no well-defined target cell (navigateToSheet, typeText,
// commitCell, ...) are absent here — the cursor simply stays wherever the last
// selection-changing step left it.
const CURSOR_RECT_PRIMITIVES: Record<string, string> = {
  selectCell: 'readActiveCellRect',
  selectRange: 'readSelectionRect',
};

// Owns the pause/resume/abort state machine and the step loop that narrates,
// dispatches, and confirms each SheetStep in turn. Deps are injected so this is
// unit-testable without Chrome APIs, mirroring sheet-plan.ts/relay.ts.
export function makeExecutionEngine(deps: ExecutionEngineDeps) {
  const { sendMessageToTab, narrator } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;

  // Closure-scoped (not module-scope) so each makeExecutionEngine(...) instance —
  // e.g. each test — gets its own independent state, mirroring relay.ts's
  // offscreenPromise pattern.
  let pauseRequested = false;
  let aborted = false;
  let resumeResolvers: Array<() => void> = [];

  function requestPause(): void {
    pauseRequested = true;
  }

  function flushResumeResolvers(): void {
    const resolvers = resumeResolvers;
    resumeResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

  function resume(): void {
    pauseRequested = false;
    flushResumeResolvers();
  }

  function abort(): void {
    aborted = true;
    flushResumeResolvers();
  }

  function waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => resumeResolvers.push(resolve));
  }

  async function runPrimitive(tabId: number, name: string, args: unknown[] = []): Promise<PrimitiveResult> {
    try {
      const result = (await sendMessageToTab(tabId, {
        type: 'RUN_PRIMITIVE',
        payload: { name, args },
      })) as PrimitiveResult | undefined;
      return result ?? { ok: false, error: `No response for primitive "${name}"` };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + confirmTimeoutMs;
    do {
      if (await predicate()) return;
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    } while (Date.now() < deadline);
  }

  // Confirms the primitive's effect actually landed in the DOM before advancing to
  // the next step. Only a handful of primitives have a well-defined confirmation —
  // others (enterEditMode, commitCell with no prior write, teach-mode primitives,
  // etc.) have nothing specific to poll for and proceed immediately.
  async function confirmStep(tabId: number, step: SheetStep, prevStep: SheetStep | undefined): Promise<void> {
    switch (step.primitive) {
      case 'selectCell': {
        const expected = step.args.ref;
        if (!expected) return;
        await waitUntil(async () => (await runPrimitive(tabId, 'readActiveCell')).result === expected);
        return;
      }
      case 'selectRange': {
        // Also gates moveCursorForStep's readSelectionRect() call below — without
        // this confirmation, the cursor would race Sheets' selection-border overlay,
        // which only renders once the range has actually landed (same reasoning as
        // selectCell's readActiveCell poll above).
        const { start, end } = step.args;
        if (!start || !end) return;
        const expected = `${start}:${end}`;
        await waitUntil(async () => (await runPrimitive(tabId, 'readActiveCell')).result === expected);
        return;
      }
      case 'navigateToSheet': {
        const expected = step.args.name;
        if (!expected) return;
        await waitUntil(async () => (await runPrimitive(tabId, 'activeSheetName')).result === expected);
        return;
      }
      case 'typeText':
      case 'writeToSelectedCell': {
        const expected = step.args.text;
        if (!expected) return;
        await waitUntil(async () => String((await runPrimitive(tabId, 'readFormulaBar')).result ?? '').includes(expected));
        return;
      }
      case 'commitCell': {
        const expected = prevStep?.args.text;
        if (!expected) return;
        await waitUntil(async () => String((await runPrimitive(tabId, 'readFormulaBar')).result ?? '').includes(expected));
        return;
      }
      default:
        return;
    }
  }

  // Only checked once, up front: a plan may legitimately contain a navigateToSheet
  // step that changes the gid on purpose partway through. Re-checking between every
  // step would abort the plan's own valid navigation the moment it ran — this guard
  // exists solely to catch the user switching sheets during the async gap while the
  // query was being processed, before execution ever started.
  async function isStillOnQueriedSheet(tabId: number, outcome: PlanOutcome): Promise<boolean> {
    const [gid, spreadsheetId] = await Promise.all([
      runPrimitive(tabId, 'readSheetGid'),
      runPrimitive(tabId, 'readSpreadsheetId'),
    ]);
    return gid.ok && spreadsheetId.ok && gid.result === outcome.sheetGid && spreadsheetId.result === outcome.spreadsheetId;
  }

  // Moves the SheetBuddy cursor to reflect a just-confirmed selection. Only
  // selection-changing primitives have a rect to read back (see
  // CURSOR_RECT_PRIMITIVES) — everything else is a no-op, leaving the cursor
  // wherever the last selection-changing step put it.
  async function moveCursorForStep(tabId: number, step: SheetStep): Promise<void> {
    const rectPrimitive = CURSOR_RECT_PRIMITIVES[step.primitive];
    if (!rectPrimitive) return;

    const result = await runPrimitive(tabId, rectPrimitive);
    if (!result.ok || !result.result) return;

    await sendMessageToTab(tabId, {
      type: 'CURSOR_MOVE_TO',
      payload: { rect: result.result as CellRect },
    }).catch(() => {});
  }

  // Speaks the pause line, dims the creature, and blocks until resume()/abort().
  // Shared by both pause checkpoints in execute()'s loop (mid-narration and
  // post-primitive) so "paused" always looks and sounds the same regardless of
  // which checkpoint caught it.
  async function pauseAndWait(tabId: number, stepIndex: number, totalSteps: number): Promise<void> {
    const currentStep = stepIndex + 1;
    const pauseLine = `Paused at step ${currentStep} of ${totalSteps} — continue or start over?`;
    await sendMessageToTab(tabId, { type: 'NARRATION_SHOW', payload: { text: pauseLine } }).catch(() => {});
    await narrator.speak(pauseLine).catch((err: unknown) => {
      console.error('[SheetBuddy] Narrator failed for pause message:', errMsg(err));
    });
    await sendMessageToTab(tabId, {
      type: 'PAUSE_AT_STEP',
      payload: { currentStep, totalSteps },
    }).catch(() => {});
    await waitForResume();
    if (!aborted) {
      await sendMessageToTab(tabId, { type: 'TASK_STARTED' }).catch(() => {});
    }
  }

  async function execute(tabId: number, outcome: PlanOutcome): Promise<ExecutionResult> {
    pauseRequested = false;
    aborted = false;
    resumeResolvers = [];

    if (!(await isStillOnQueriedSheet(tabId, outcome))) {
      console.error('[SheetBuddy] Aborting plan: active sheet changed while the query was processing');
      await sendMessageToTab(tabId, { type: 'TASK_COMPLETE' }).catch(() => {});
      return { status: 'stale-sheet' };
    }

    await sendMessageToTab(tabId, { type: 'TASK_STARTED' }).catch(() => {});

    const { steps } = outcome.plan;
    let i = 0;
    while (i < steps.length && !aborted) {
      const step = steps[i];

      // Shown the moment narration starts (not after the primitive confirms, which
      // is often well after this step's audio already finished) — content/index.ts
      // routes it to the cursor's label if a cell is already landed on, or the
      // creature's bubble otherwise.
      await sendMessageToTab(tabId, { type: 'NARRATION_SHOW', payload: { text: step.narration } }).catch(() => {});

      // Narration failing (e.g. the real TTSNarrator's network request rejects) must
      // not abort the loop early — that would skip the trailing TASK_COMPLETE below
      // and leave the creature stuck "active" forever, the exact failure mode
      // sheet-plan.ts's own TASK_COMPLETE handling exists to prevent.
      await narrator.speak(step.narration).catch((err: unknown) => {
        console.error(`[SheetBuddy] Narrator failed at step ${step.stepNumber}:`, errMsg(err));
      });

      if (aborted) break;

      // Real TTS narration takes real time — a pause requested mid-narration must
      // stop here, before the primitive fires, not just stop the audio. Nothing
      // has executed yet, so resuming re-narrates and re-attempts this same step.
      if (pauseRequested) {
        await pauseAndWait(tabId, i, steps.length);
        if (aborted) break;
        continue;
      }

      const result = await runPrimitive(tabId, step.primitive, toPositionalArgs(step.primitive, step.args));
      if (!result.ok) {
        console.error(`[SheetBuddy] Primitive "${step.primitive}" failed at step ${step.stepNumber}:`, result.error);
      } else {
        await confirmStep(tabId, step, steps[i - 1]);
        await moveCursorForStep(tabId, step);
      }

      if (aborted) break;

      if (pauseRequested) {
        await pauseAndWait(tabId, i, steps.length);
        if (aborted) break;
      }

      i++;
    }

    await sendMessageToTab(tabId, { type: 'TASK_COMPLETE' }).catch(() => {});
    return aborted ? { status: 'aborted' } : { status: 'completed' };
  }

  return { execute, requestPause, resume, abort };
}
