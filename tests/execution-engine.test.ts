import { describe, it, expect, vi } from 'vitest';
import { makeExecutionEngine, MockNarrator, type ExecutionEngineDeps } from '../src/background/execution-engine';
import type { Narrator } from '../src/offscreen/narrator';
import type { Message, SheetPlan, SheetStep } from '../src/types/messages';
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
  overrides: { sheetGid?: string; spreadsheetId?: string } = {},
): Extract<SheetPlanOutcome, { status: 'plan' }> {
  return {
    status: 'plan',
    plan: plan(steps),
    sheetGid: overrides.sheetGid ?? '0',
    spreadsheetId: overrides.spreadsheetId ?? 'abc',
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

function messagesOfType(sendMessageToTab: ReturnType<typeof vi.fn>, type: string): unknown[] {
  return sendMessageToTab.mock.calls.filter(([, m]) => (m as Message).type === type).map(([, m]) => m);
}

function dispatchedPrimitiveNames(sendMessageToTab: ReturnType<typeof vi.fn>): string[] {
  return sendMessageToTab.mock.calls
    .filter(([, m]) => (m as Message).type === 'RUN_PRIMITIVE')
    .map(([, m]) => ((m as Message).payload as { name: string }).name)
    .filter((name) => !['readSheetGid', 'readSpreadsheetId', 'readActiveCell', 'activeSheetName', 'readFormulaBar'].includes(name));
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
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', args: { text: '=SUM(A1:A5)' } }),
      step({ stepNumber: 3, primitive: 'commitCell' }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    engine.requestPause();

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
    const { sendMessageToTab } = makeFakeTab();
    const engine = makeExecutionEngine(baseDeps({ sendMessageToTab }));
    const outcome = planOutcome([
      step({ stepNumber: 1, primitive: 'selectCell', args: { ref: 'B7' } }),
      step({ stepNumber: 2, primitive: 'typeText', args: { text: '=SUM(A1:A5)' } }),
    ]);

    const executePromise = engine.execute(TAB_ID, outcome);
    engine.requestPause();
    await vi.waitFor(() => expect(messagesOfType(sendMessageToTab, 'PAUSE_AT_STEP')).toHaveLength(1));

    engine.abort();
    const result = await executePromise;

    expect(result).toEqual({ status: 'aborted' });
    expect(dispatchedPrimitiveNames(sendMessageToTab)).toEqual(['selectCell']);
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
});
