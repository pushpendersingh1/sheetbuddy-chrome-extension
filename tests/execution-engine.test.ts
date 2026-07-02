import { describe, it, expect, vi } from 'vitest';
import { makeExecutionEngine, MockNarrator, type ExecutionEngineDeps } from '../src/background/execution-engine';
import type { Narrator } from '../src/offscreen/narrator';
import type { CellRect, Message, SheetPlan, SheetStep } from '../src/types/messages';
import type { SheetPlanOutcome } from '../src/background/sheet-plan';

const TAB_ID = 7;

function step(partial: {
  stepNumber: number;
  primitive: string;
  narration?: string;
  description?: string;
  args?: Record<string, string>;
}): SheetStep {
  return {
    stepNumber: partial.stepNumber,
    description: partial.description ?? `step ${partial.stepNumber}`,
    narration: partial.narration ?? `narrating step ${partial.stepNumber}`,
    primitive: partial.primitive,
    args: partial.args ?? {},
  };
}

function plan(steps: SheetStep[]): SheetPlan {
  return { totalSteps: steps.length, summary: 'summary', steps };
}

function planOutcome(
  steps: SheetStep[],
  overrides: { sheetGid?: string; spreadsheetId?: string; sheetName?: string } = {},
): Extract<SheetPlanOutcome, { status: 'plan' }> {
  return {
    status: 'plan',
    plan: plan(steps),
    sheetGid: overrides.sheetGid ?? '0',
    spreadsheetId: overrides.spreadsheetId ?? 'abc',
    sheetName: overrides.sheetName ?? 'Sheet1',
  };
}

interface FakeTabOptions {
  sheetGid?: string;
  spreadsheetId?: string;
  activeCell?: string;
  sheetName?: string;
  formulaBar?: string;
  // Artificial lag before a dispatched primitive's DOM effect becomes observable —
  // mirrors Sheets' own async selection/render catch-up (see readColumnHeaders in
  // primitives.ts), which is exactly what the DOM-confirmation poll exists to handle.
  delayMs?: Partial<Record<string, number>>;
  fail?: string[];
}

function makeFakeTab(opts: FakeTabOptions = {}) {
  const state = {
    sheetGid: opts.sheetGid ?? '0',
    spreadsheetId: opts.spreadsheetId ?? 'abc',
    activeCell: opts.activeCell ?? '',
    sheetName: opts.sheetName ?? 'Sheet1',
    formulaBar: opts.formulaBar ?? '',
  };
  const dispatched: string[] = [];

  function applyEffect(name: string, args: unknown[]) {
    if (name === 'selectCell') state.activeCell = args[0] as string;
    // Mirrors selectRange's real DOM effect: Sheets' name box shows "start:end"
    // (confirmed via live inspection — nameBox.value === "A1:B3" after selecting A1:B3).
    if (name === 'selectRange') state.activeCell = `${args[0]}:${args[1]}`;
    if (name === 'navigateToSheet') state.sheetName = args[0] as string;
    if (name === 'typeText' || name === 'writeToSelectedCell') state.formulaBar = args[0] as string;
  }

  const sendMessageToTab = vi.fn(async (_tabId: number, message: Message): Promise<unknown> => {
    if (message.type !== 'RUN_PRIMITIVE') return { ok: true };
    const { name, args = [] } = message.payload as { name: string; args?: unknown[] };

    switch (name) {
      case 'readSheetGid': return { ok: true, result: state.sheetGid };
      case 'readSpreadsheetId': return { ok: true, result: state.spreadsheetId };
      case 'readActiveCell': return { ok: true, result: state.activeCell };
      case 'activeSheetName': return { ok: true, result: state.sheetName };
      case 'readFormulaBar': return { ok: true, result: state.formulaBar };
      // No selection overlay in this fake by default — tests that care about the
      // SheetBuddy cursor's rect read-back use withRectPrimitives() to override.
      case 'readActiveCellRect': return { ok: true, result: null };
      case 'readSelectionRect': return { ok: true, result: null };
    }

    dispatched.push(name);
    if (opts.fail?.includes(name)) return { ok: false, error: `${name} failed` };

    const delay = opts.delayMs?.[name];
    if (delay) {
      setTimeout(() => applyEffect(name, args), delay);
    } else {
      applyEffect(name, args);
    }
    return { ok: true };
  });

  return { sendMessageToTab, state, dispatched };
}

function baseDeps(overrides: Partial<ExecutionEngineDeps> = {}): ExecutionEngineDeps {
  return {
    sendMessageToTab: makeFakeTab().sendMessageToTab,
    narrator: MockNarrator,
    pollIntervalMs: 2,
    confirmTimeoutMs: 100,
    ...overrides,
  };
}

// Wraps a fake tab's sendMessageToTab so RUN_PRIMITIVE calls for the cursor's
// rect-lookup primitives return fixed values, instead of makeFakeTab's default
// (which doesn't know about them).
function withRectPrimitives(
  base: (tabId: number, message: Message) => Promise<unknown>,
  rects: { active?: CellRect | null; selection?: CellRect | null },
) {
  return vi.fn(async (tabId: number, message: Message) => {
    if (message.type === 'RUN_PRIMITIVE') {
      const { name } = message.payload as { name: string };
      if (name === 'readActiveCellRect') return { ok: true, result: rects.active ?? null };
      if (name === 'readSelectionRect') return { ok: true, result: rects.selection ?? null };
    }
    return base(tabId, message);
  });
}

function messagesOfType(sendMessageToTab: ReturnType<typeof vi.fn>, type: string): unknown[] {
  return sendMessageToTab.mock.calls.filter(([, m]) => (m as Message).type === type).map(([, m]) => m);
}

function dispatchedPrimitiveNames(sendMessageToTab: ReturnType<typeof vi.fn>): string[] {
  const readOnlyPrimitives = [
    'readSheetGid', 'readSpreadsheetId', 'readActiveCell', 'activeSheetName', 'readFormulaBar',
    'readActiveCellRect', 'readSelectionRect',
  ];
  return sendMessageToTab.mock.calls
    .filter(([, m]) => (m as Message).type === 'RUN_PRIMITIVE')
    .map(([, m]) => ((m as Message).payload as { name: string }).name)
    .filter((name) => !readOnlyPrimitives.includes(name));
}

describe('MockNarrator', () => {
  it('logs the narration text to console and resolves immediately', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(MockNarrator.speak('Selecting B7')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Selecting B7'));
    spy.mockRestore();
  });
});

describe('makeExecutionEngine', () => {
  it('executes all steps of a 3-step plan in order, narrating before each primitive', async () => {
    const narrated: string[] = [];
    const narrator: Narrator = { speak: async (text) => { narrated.push(text); } };
    const { sendMessageToTab, dispatched } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, narrator }));

    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', narration: 'Going to B7', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', narration: 'Typing formula', args: { text: '=SUM(A1:A5)' } }),
      step({ stepNumber: 3, primitive: 'commitCell', narration: 'Committing' }),
    ]);

    const result = await engine.execute(TAB_ID, outcome);

    expect(result).toEqual({ status: 'completed' });
    expect(narrated).toEqual(['Going to B7', 'Typing formula', 'Committing']);
    expect(dispatched).toEqual(['selectCell', 'typeText', 'commitCell']);
  });

  it('sends NARRATION_SHOW with each step\'s narration text before speaking it', async () => {
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', narration: 'Going to B7', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'commitCell', narration: 'Committing' }),
    ]);

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'NARRATION_SHOW')).toEqual([
      { type: 'NARRATION_SHOW', payload: { text: 'Going to B7' } },
      { type: 'NARRATION_SHOW', payload: { text: 'Committing' } },
    ]);
  });

  it('sends TASK_STARTED before the first step and TASK_COMPLETE after the last', async () => {
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'commitCell' })]);

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'TASK_STARTED')).toEqual([{ type: 'TASK_STARTED' }]);
    expect(messagesOfType(sendMessageToTab, 'TASK_COMPLETE')).toEqual([{ type: 'TASK_COMPLETE' }]);
  });

  it('dispatches primitive args positionally, matching each primitive\'s own parameter order', async () => {
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } })]);

    await engine.execute(TAB_ID, outcome);

    const call = sendMessageToTab.mock.calls.find(
      ([, m]) => (m as Message).type === 'RUN_PRIMITIVE' && ((m as Message).payload as { name: string }).name === 'selectCell',
    );
    expect(call?.[1]).toMatchObject({ payload: { name: 'selectCell', args: ['B7'] } });
  });

  it('polls DOM confirmation and does not report a step done until the DOM catches up', async () => {
    const { sendMessageToTab, dispatched } = makeFakeTab({ delayMs: { selectCell: 30 } });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, pollIntervalMs: 5, confirmTimeoutMs: 500 }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'commitCell' }),
    ]);

    const result = await engine.execute(TAB_ID, outcome);

    expect(result).toEqual({ status: 'completed' });
    expect(dispatched).toEqual(['selectCell', 'commitCell']);
    const readActiveCellCalls = sendMessageToTab.mock.calls.filter(
      ([, m]) => (m as Message).type === 'RUN_PRIMITIVE' && ((m as Message).payload as { name: string }).name === 'readActiveCell',
    ).length;
    expect(readActiveCellCalls).toBeGreaterThan(1);
  });

  it('polls DOM confirmation for selectRange too, before reading the cursor\'s rect', async () => {
    // Without this poll, moveCursorForStep's readSelectionRect() call would race
    // Sheets' selection-border overlay, which (like the active-cell-border overlay
    // selectCell confirms against) only renders once the DOM has caught up.
    const rect: CellRect = { x: 45, y: 165, width: 203, height: 64 };
    const { sendMessageToTab: baseFake, dispatched } = makeFakeTab({ delayMs: { selectRange: 30 } });
    const sendMessageToTab = withRectPrimitives(baseFake, { selection: rect });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, pollIntervalMs: 5, confirmTimeoutMs: 500 }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'selectRange', args: { start: 'A1', end: 'B3' } })]);

    const result = await engine.execute(TAB_ID, outcome);

    expect(result).toEqual({ status: 'completed' });
    expect(dispatched).toEqual(['selectRange']);
    const readActiveCellCalls = sendMessageToTab.mock.calls.filter(
      ([, m]) => (m as Message).type === 'RUN_PRIMITIVE' && ((m as Message).payload as { name: string }).name === 'readActiveCell',
    ).length;
    expect(readActiveCellCalls).toBeGreaterThan(1);
    // The cursor still ends up in the right place once the DOM (and thus the
    // confirmation poll) catches up.
    expect(messagesOfType(sendMessageToTab, 'CURSOR_MOVE_TO')).toEqual([
      { type: 'CURSOR_MOVE_TO', payload: { rect } },
    ]);
  });

  it('logs and continues when a primitive fails, without crashing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendMessageToTab, dispatched } = makeFakeTab({ fail: ['typeText'] });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', args: { text: '=SUM(A1:A5)' } }),
      step({ stepNumber: 3, primitive: 'commitCell' }),
    ]);

    const result = await expect(engine.execute(TAB_ID, outcome)).resolves.toEqual({ status: 'completed' });
    void result;

    expect(dispatched).toEqual(['selectCell', 'typeText', 'commitCell']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('typeText'), expect.anything());
    errorSpy.mockRestore();
  });

  it('logs and continues when the narrator rejects, still sending TASK_COMPLETE', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const narrator: Narrator = { speak: () => Promise.reject(new Error('TTS request failed: 500')) };
    const { sendMessageToTab, dispatched } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, narrator }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'commitCell' }),
    ]);

    const result = await engine.execute(TAB_ID, outcome);

    expect(result).toEqual({ status: 'completed' });
    expect(dispatched).toEqual(['selectCell', 'commitCell']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Narrator failed'), expect.anything());
    expect(messagesOfType(sendMessageToTab, 'TASK_COMPLETE')).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('pauses after the in-flight step completes, without interrupting it mid-step', async () => {
    // selectCell's DOM effect lands 20ms late — requestPause() fires at t=5ms,
    // after selectCell has already dispatched but before confirmStep's poll
    // succeeds, so this exercises the post-primitive checkpoint specifically
    // (the pre-primitive/mid-narration checkpoint is covered by its own test below).
    const { sendMessageToTab } = makeFakeTab({ delayMs: { selectCell: 20 } });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, pollIntervalMs: 2, confirmTimeoutMs: 200 }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', args: { text: '=SUM(A1:A5)' } }),
      step({ stepNumber: 3, primitive: 'commitCell' }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    setTimeout(() => engine.requestPause(), 5);

    await vi.waitFor(() => {
      expect(messagesOfType(sendMessageToTab, 'PAUSE_AT_STEP')).toEqual([
        { type: 'PAUSE_AT_STEP', payload: { currentStep: 1, totalSteps: 3 } },
      ]);
    });

    // step 1 completed before the pause; steps 2/3 must not have fired yet
    expect(dispatchedPrimitiveNames(sendMessageToTab)).toEqual(['selectCell']);

    engine.resume();
    const result = await executePromise;

    expect(result).toEqual({ status: 'completed' });
    expect(dispatchedPrimitiveNames(sendMessageToTab)).toEqual(['selectCell', 'typeText', 'commitCell']);
  });

  it('re-sends TASK_STARTED on resume so the creature un-dims', async () => {
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'commitCell' }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    engine.requestPause();
    await vi.waitFor(() => expect(messagesOfType(sendMessageToTab, 'PAUSE_AT_STEP')).toHaveLength(1));

    engine.resume();
    await executePromise;

    expect(messagesOfType(sendMessageToTab, 'TASK_STARTED')).toHaveLength(2);
  });

  it('stops cleanly when aborted while paused, without dispatching remaining steps', async () => {
    // See the timing note on the previous test — same reasoning applies here.
    const { sendMessageToTab } = makeFakeTab({ delayMs: { selectCell: 20 } });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, pollIntervalMs: 2, confirmTimeoutMs: 200 }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', args: { text: '=SUM(A1:A5)' } }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    setTimeout(() => engine.requestPause(), 5);
    await vi.waitFor(() => expect(messagesOfType(sendMessageToTab, 'PAUSE_AT_STEP')).toHaveLength(1));

    engine.abort();
    const result = await executePromise;

    expect(result).toEqual({ status: 'aborted' });
    expect(dispatchedPrimitiveNames(sendMessageToTab)).toEqual(['selectCell']);
    expect(messagesOfType(sendMessageToTab, 'TASK_COMPLETE')).toHaveLength(1);
  });

  it('skips the primitive when pause is requested mid-narration, then retries the same step\'s narration on resume', async () => {
    // Only the step's very first speak() call is held pending; every later call
    // (the pause-narration line, and the retried narration after resume) resolves
    // immediately — isolates the mid-narration checkpoint without needing to
    // juggle multiple simultaneously-pending narrator promises.
    const narrated: string[] = [];
    let callCount = 0;
    let releaseFirst: (() => void) | null = null;
    const narrator: Narrator = {
      speak: (text) => {
        narrated.push(text);
        callCount++;
        if (callCount === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
        return Promise.resolve();
      },
    };
    const { sendMessageToTab, dispatched } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, narrator }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', narration: 'Going to B7', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'commitCell', narration: 'Committing' }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    await vi.waitFor(() => expect(narrated).toEqual(['Going to B7']));
    engine.requestPause();
    releaseFirst!();

    await vi.waitFor(() => expect(messagesOfType(sendMessageToTab, 'PAUSE_AT_STEP')).toHaveLength(1));
    // Narration for step 1 finished, but its primitive must not have fired —
    // pause was requested before runPrimitive, not after.
    expect(dispatched).toEqual([]);
    expect(narrated).toEqual(['Going to B7', 'Paused at step 1 of 2 — continue or start over?']);
    // The pause line gets a NARRATION_SHOW too, same as any other narration.
    expect(messagesOfType(sendMessageToTab, 'NARRATION_SHOW')).toContainEqual(
      { type: 'NARRATION_SHOW', payload: { text: 'Paused at step 1 of 2 — continue or start over?' } },
    );

    engine.resume();
    const result = await executePromise;

    expect(result).toEqual({ status: 'completed' });
    // Step 1's narration and primitive both ran again from scratch on retry — lossless.
    expect(dispatched).toEqual(['selectCell', 'commitCell']);
    expect(narrated).toEqual([
      'Going to B7',
      'Paused at step 1 of 2 — continue or start over?',
      'Going to B7',
      'Committing',
    ]);
  });

  it('sends CURSOR_MOVE_TO with the active-cell rect after a selectCell step confirms', async () => {
    const rect: CellRect = { x: 45, y: 165, width: 102, height: 22 };
    const { sendMessageToTab: baseFake } = makeFakeTab();
    const sendMessageToTab = withRectPrimitives(baseFake, { active: rect });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } })]);

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'CURSOR_MOVE_TO')).toEqual([
      { type: 'CURSOR_MOVE_TO', payload: { rect } },
    ]);
  });

  it('sends CURSOR_MOVE_TO with the selection rect after a selectRange step confirms', async () => {
    const rect: CellRect = { x: 45, y: 165, width: 203, height: 64 };
    const { sendMessageToTab: baseFake } = makeFakeTab();
    const sendMessageToTab = withRectPrimitives(baseFake, { selection: rect });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectRange', args: { start: 'A1', end: 'B3' } }),
    ]);

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'CURSOR_MOVE_TO')).toEqual([
      { type: 'CURSOR_MOVE_TO', payload: { rect } },
    ]);
  });

  it('does not send CURSOR_MOVE_TO for primitives with no cell target (e.g. commitCell)', async () => {
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'commitCell' })]);

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'CURSOR_MOVE_TO')).toEqual([]);
  });

  it('does not send CURSOR_MOVE_TO when the rect read-back comes back null', async () => {
    const { sendMessageToTab: baseFake } = makeFakeTab();
    const sendMessageToTab = withRectPrimitives(baseFake, { active: null });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } })]);

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'CURSOR_MOVE_TO')).toEqual([]);
  });

  it('does not send CURSOR_MOVE_TO when the primitive itself failed', async () => {
    const { sendMessageToTab: baseFake } = makeFakeTab({ fail: ['selectCell'] });
    const sendMessageToTab = withRectPrimitives(baseFake, { active: { x: 1, y: 2, width: 3, height: 4 } });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } })]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await engine.execute(TAB_ID, outcome);

    expect(messagesOfType(sendMessageToTab, 'CURSOR_MOVE_TO')).toEqual([]);
    errorSpy.mockRestore();
  });

  it('stops between steps when aborted mid-run without ever pausing first', async () => {
    // selectCell's DOM effect lands 20ms late, so at t=10ms the engine is still
    // polling confirmStep for step 1 — abort() fires while nothing is paused.
    const { sendMessageToTab, dispatched } = makeFakeTab({ delayMs: { selectCell: 20 } });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, pollIntervalMs: 2, confirmTimeoutMs: 200 }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', args: { text: '=SUM(A1:A5)' } }),
      step({ stepNumber: 3, primitive: 'commitCell' }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    setTimeout(() => engine.abort(), 10);
    const result = await executePromise;

    expect(result).toEqual({ status: 'aborted' });
    expect(dispatched).toEqual(['selectCell']);
    expect(messagesOfType(sendMessageToTab, 'TASK_COMPLETE')).toHaveLength(1);
  });

  it('aborts before executing anything when the active sheet no longer matches the outcome', async () => {
    const { sendMessageToTab, dispatched } = makeFakeTab({ sheetGid: '999999', spreadsheetId: 'abc' });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } })], {
      sheetGid: '0',
      spreadsheetId: 'abc',
    });

    const result = await engine.execute(TAB_ID, outcome);

    expect(result).toEqual({ status: 'stale-sheet' });
    expect(dispatched).toEqual([]);
    expect(messagesOfType(sendMessageToTab, 'TASK_STARTED')).toEqual([]);
    expect(messagesOfType(sendMessageToTab, 'TASK_COMPLETE')).toHaveLength(1);
  });

  it('does not abort a plan that legitimately navigates to a different sheet as one of its own steps', async () => {
    let gidReadCount = 0;
    const { sendMessageToTab: baseFake } = makeFakeTab();
    const sendMessageToTab = vi.fn(async (tabId: number, message: Message) => {
      if (message.type === 'RUN_PRIMITIVE' && (message.payload as { name: string }).name === 'readSheetGid') {
        gidReadCount++;
      }
      return baseFake(tabId, message);
    });
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'navigateToSheet', args: { name: 'Sheet2' } }),
      step({ stepNumber: 2, primitive: 'selectCell', args: { ref: 'A1' } }),
    ]);

    const result = await engine.execute(TAB_ID, outcome);

    expect(result).toEqual({ status: 'completed' });
    // The staleness guard only runs once, up front — never re-checked mid-plan,
    // so the plan's own navigateToSheet step can't trip it.
    expect(gidReadCount).toBe(1);
  });

  describe('Sheets API fallback (graceful degradation)', () => {
    function writePlan() {
      return planOutcome([
        step({ stepNumber: 1, primitive: 'selectCell', narration: 'Going to B7', args: { ref: 'B7' } }),
        step({ stepNumber: 2, primitive: 'typeText', narration: 'Typing formula', args: { text: '=SUM(A1:A5)' } }),
        step({ stepNumber: 3, primitive: 'commitCell', narration: 'Committing' }),
      ]);
    }

    it('writes via the Sheets API when a write primitive\'s DOM path fails, and the plan completes', async () => {
      const narrated: string[] = [];
      const narrator: Narrator = { speak: async (text) => { narrated.push(text); } };
      const writeCell = vi.fn().mockResolvedValue(undefined);
      const { sendMessageToTab } = makeFakeTab({ fail: ['typeText'] });
      const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, narrator, sheetsApi: { writeCell } }));

      const result = await engine.execute(TAB_ID, writePlan());

      expect(result).toEqual({ status: 'completed' });
      expect(writeCell).toHaveBeenCalledWith('abc', "'Sheet1'!B7", '=SUM(A1:A5)');
      expect(narrated).toContain('I switched to a fallback approach here — it still worked.');
    });

    it('skips the paired commitCell after a successful API fallback — the API write is already committed', async () => {
      const writeCell = vi.fn().mockResolvedValue(undefined);
      const { sendMessageToTab, dispatched } = makeFakeTab({ fail: ['typeText'] });
      const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, sheetsApi: { writeCell } }));

      await engine.execute(TAB_ID, writePlan());

      expect(dispatched).toEqual(['selectCell', 'typeText']);
    });

    it('reports the failure clearly and stops when the API fallback also fails', async () => {
      const narrated: string[] = [];
      const narrator: Narrator = { speak: async (text) => { narrated.push(text); } };
      const writeCell = vi.fn().mockRejectedValue(new Error('OAuth declined'));
      const { sendMessageToTab, dispatched } = makeFakeTab({ fail: ['typeText'] });
      const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, narrator, sheetsApi: { writeCell } }));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await engine.execute(TAB_ID, writePlan());
      errorSpy.mockRestore();

      expect(result).toEqual({ status: 'failed' });
      expect(narrated).toContain(
        "Sorry, I couldn't complete step 2 — step 2. I tried a fallback approach, but that failed too, so I've stopped here.",
      );
      // The plan stops at the failed step — the trailing commitCell never runs —
      // but the creature is still released back to idle.
      expect(dispatched).toEqual(['selectCell', 'typeText']);
      expect(messagesOfType(sendMessageToTab, 'TASK_COMPLETE')).toHaveLength(1);
    });

    it('keeps the old log-and-continue behavior for failed non-write primitives', async () => {
      const writeCell = vi.fn();
      const { sendMessageToTab, dispatched } = makeFakeTab({ fail: ['navigateToSheet'] });
      const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, sheetsApi: { writeCell } }));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await engine.execute(TAB_ID, planOutcome([
        step({ stepNumber: 1, primitive: 'navigateToSheet', args: { name: 'Sheet2' } }),
        step({ stepNumber: 2, primitive: 'selectCell', args: { ref: 'A1' } }),
      ]));
      errorSpy.mockRestore();

      expect(result).toEqual({ status: 'completed' });
      expect(writeCell).not.toHaveBeenCalled();
      expect(dispatched).toEqual(['navigateToSheet', 'selectCell']);
    });

    it('falls back to the sheet the plan was built against when the DOM is too broken to read the sheet name', async () => {
      const writeCell = vi.fn().mockResolvedValue(undefined);
      const { sendMessageToTab: baseFake } = makeFakeTab({ fail: ['typeText'] });
      const sendMessageToTab = vi.fn(async (tabId: number, message: Message) => {
        if (message.type === 'RUN_PRIMITIVE' && (message.payload as { name: string }).name === 'activeSheetName') {
          return { ok: false, error: 'sheet tab strip not found' };
        }
        return baseFake(tabId, message);
      });
      const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, sheetsApi: { writeCell } }));

      const result = await engine.execute(TAB_ID, planOutcome(writePlan().plan.steps, { sheetName: 'Q3 Budget' }));

      expect(result).toEqual({ status: 'completed' });
      expect(writeCell).toHaveBeenCalledWith('abc', "'Q3 Budget'!B7", '=SUM(A1:A5)');
    });

    it('targets the live active cell when the plan has no earlier selectCell step', async () => {
      const writeCell = vi.fn().mockResolvedValue(undefined);
      const { sendMessageToTab } = makeFakeTab({ fail: ['writeToSelectedCell'], activeCell: 'D4' });
      const engine = makeExecutionEngine(baseDeps({ sendMessageToTab, sheetsApi: { writeCell } }));

      const result = await engine.execute(TAB_ID, planOutcome([
        step({ stepNumber: 1, primitive: 'writeToSelectedCell', args: { text: 'hello' } }),
      ]));

      expect(result).toEqual({ status: 'completed' });
      expect(writeCell).toHaveBeenCalledWith('abc', "'Sheet1'!D4", 'hello');
    });
  });
});
