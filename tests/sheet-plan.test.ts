import { describe, it, expect, vi } from 'vitest';
import { makeSheetPlanHandler, type SheetPlanDeps } from '../src/background/sheet-plan';
import type { DOMContext, Message } from '../src/types/messages';

const WORKER_URL = 'https://worker.example.com';
const TAB_ID = 7;

const SAMPLE_CONTEXT: DOMContext = {
  activeCell: 'C2',
  formulaBar: '',
  spreadsheetId: 'abc',
  sheetGid: '0',
  sheetName: 'Sheet1',
  columnHeaders: ['Name', 'Sales'],
  availableSheets: ['Sheet1'],
};

function jsonResponse(
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function makeSendMessageToTab(opts: { contextError?: string } = {}) {
  return vi.fn(async (_tabId: number, message: Message) => {
    if (message.type === 'RUN_PRIMITIVE') {
      if (opts.contextError) return { ok: false, error: opts.contextError };
      return { ok: true, result: SAMPLE_CONTEXT };
    }
    if (message.type === 'TASK_COMPLETE') return { ok: true };
    throw new Error(`Unexpected message in test: ${message.type}`);
  });
}

function makeDeps(overrides: Partial<SheetPlanDeps> = {}): SheetPlanDeps {
  return {
    fetchFn: vi.fn().mockResolvedValue(
      jsonResponse({ totalSteps: 0, summary: 'ok', steps: [] }),
    ) as unknown as typeof fetch,
    captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
    sendMessageToTab: makeSendMessageToTab(),
    workerUrl: WORKER_URL,
    ...overrides,
  };
}

describe('makeSheetPlanHandler', () => {
  it('returns a plan and sends TASK_COMPLETE on a valid structured response', async () => {
    const validPlan = {
      totalSteps: 1,
      summary: 'Summing column B',
      steps: [{
        stepNumber: 1,
        description: 'Select C2',
        narration: 'Selecting C2',
        primitive: 'selectCell',
        args: { ref: 'C2' },
      }],
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(validPlan)) as unknown as typeof fetch;
    const sendMessageToTab = makeSendMessageToTab();
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, sendMessageToTab }));

    const outcome = await handleUserQuery(TAB_ID, 'sum column B into C2');

    expect(outcome).toEqual({
      status: 'plan',
      plan: validPlan,
      sheetGid: SAMPLE_CONTEXT.sheetGid,
      spreadsheetId: SAMPLE_CONTEXT.spreadsheetId,
    });
    expect(sendMessageToTab).toHaveBeenCalledWith(TAB_ID, { type: 'TASK_COMPLETE' });
  });

  it("carries the collected sheet's gid and spreadsheetId, not a hardcoded value", async () => {
    const otherSheetContext: DOMContext = { ...SAMPLE_CONTEXT, sheetGid: '482910335', spreadsheetId: 'xyz-789' };
    const validPlan = { totalSteps: 0, summary: 'ok', steps: [{
      stepNumber: 1, description: 'Select C2', narration: 'Selecting C2', primitive: 'selectCell', args: { ref: 'C2' },
    }] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(validPlan)) as unknown as typeof fetch;
    const sendMessageToTab = vi.fn(async (_tabId: number, message: Message) => {
      if (message.type === 'RUN_PRIMITIVE') return { ok: true, result: otherSheetContext };
      if (message.type === 'TASK_COMPLETE') return { ok: true };
      throw new Error(`Unexpected message in test: ${message.type}`);
    });
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, sendMessageToTab }));

    const outcome = await handleUserQuery(TAB_ID, 'sum column B into C2');

    expect(outcome).toMatchObject({ sheetGid: '482910335', spreadsheetId: 'xyz-789' });
  });

  it('sends text and domContext to /chat, plus a screenshot for a visual-reasoning query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ totalSteps: 0, summary: 'ok', steps: [] }),
    ) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    await handleUserQuery(TAB_ID, 'what color is the header row');

    expect(fetchFn).toHaveBeenCalledWith(
      `${WORKER_URL}/chat`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'what color is the header row',
          domContext: SAMPLE_CONTEXT,
          screenshot: 'data:image/png;base64,abc',
        }),
      }),
    );
  });

  it('does not capture a screenshot for a query with no visual-reasoning cues', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ totalSteps: 0, summary: 'ok', steps: [] }),
    ) as unknown as typeof fetch;
    const captureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,abc');
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, captureVisibleTab }));

    await handleUserQuery(TAB_ID, 'sum column B into C2');

    expect(captureVisibleTab).not.toHaveBeenCalled();
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string) as { screenshot?: string };
    expect(body.screenshot).toBeUndefined();
  });

  it("passes through the worker's own advisor fallback", async () => {
    const advisorPlan = { totalSteps: 0, summary: 'I could not tell what you meant', steps: [] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(advisorPlan)) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'huh?');

    expect(outcome).toEqual({ status: 'advisor', plan: advisorPlan });
  });

  it('falls back to advisor mode when steps is missing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ summary: 'partial response' }),
    ) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome).toEqual({
      status: 'advisor',
      plan: { totalSteps: 0, summary: 'partial response', steps: [] },
    });
  });

  it('falls back to advisor mode when steps is not an array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ summary: 'weird', steps: 'nope' }),
    ) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome).toEqual({
      status: 'advisor',
      plan: { totalSteps: 0, summary: 'weird', steps: [] },
    });
  });

  it('falls back to advisor mode when a step is missing required fields', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ summary: 'bad step', steps: [{ stepNumber: 1 }] }),
    ) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome).toEqual({
      status: 'advisor',
      plan: { totalSteps: 0, summary: 'bad step', steps: [] },
    });
  });

  it('falls back to a generic message when even summary is missing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nonsense: true })) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome.status).toBe('advisor');
    if (outcome.status === 'advisor') {
      expect(outcome.plan.summary).toMatch(/couldn't understand/i);
    }
  });

  it('normalizes totalSteps to steps.length instead of trusting the reported count', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      totalSteps: 99,
      summary: 'one step really',
      steps: [{ stepNumber: 1, description: 'd', narration: 'n', primitive: 'selectCell', args: { ref: 'A1' } }],
    })) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome.status).toBe('plan');
    if (outcome.status === 'plan') expect(outcome.plan.totalSteps).toBe(1);
  });

  it("defaults a step's args to {} when absent", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      totalSteps: 1,
      summary: 's',
      steps: [{ stepNumber: 1, description: 'd', narration: 'n', primitive: 'commitCell' }],
    })) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome.status).toBe('plan');
    if (outcome.status === 'plan') expect(outcome.plan.steps[0].args).toEqual({});
  });

  it('proceeds without a screenshot when captureVisibleTab fails on a visual-reasoning query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ totalSteps: 0, summary: 'ok', steps: [] }),
    ) as unknown as typeof fetch;
    const captureVisibleTab = vi.fn().mockRejectedValue(new Error('capture failed'));
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, captureVisibleTab }));

    const outcome = await handleUserQuery(TAB_ID, 'what does this chart look like');

    expect(captureVisibleTab).toHaveBeenCalled();
    expect(outcome.status).toBe('advisor');
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string) as { screenshot?: string };
    expect(body.screenshot).toBeUndefined();
  });

  it('short-circuits to an error without calling /chat when DOM context collection fails', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const sendMessageToTab = makeSendMessageToTab({ contextError: 'content script not found' });
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, sendMessageToTab }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome.status).toBe('error');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sendMessageToTab).toHaveBeenCalledWith(TAB_ID, { type: 'TASK_COMPLETE' });
  });

  it('returns an error when sendMessageToTab rejects while collecting context', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const sendMessageToTab = vi.fn(async (_tabId: number, message: Message) => {
      if (message.type === 'RUN_PRIMITIVE') throw new Error('tab closed');
      return { ok: true };
    });
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, sendMessageToTab }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome.status).toBe('error');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns an error on a network failure calling /chat', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const sendMessageToTab = makeSendMessageToTab();
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, sendMessageToTab }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome.status).toBe('error');
    expect(sendMessageToTab).toHaveBeenCalledWith(TAB_ID, { type: 'TASK_COMPLETE' });
  });

  it("returns an error with the worker's message on a non-2xx response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'Claude API error' }, { ok: false, status: 500 }),
    ) as unknown as typeof fetch;
    const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn }));

    const outcome = await handleUserQuery(TAB_ID, 'do something');

    expect(outcome).toEqual({ status: 'error', error: 'Claude API error' });
  });

  it('times out rather than hanging forever when /chat never responds', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as unknown as typeof fetch;
      const sendMessageToTab = makeSendMessageToTab();
      const handleUserQuery = makeSheetPlanHandler(makeDeps({ fetchFn, sendMessageToTab }));

      const outcomePromise = handleUserQuery(TAB_ID, 'do something');
      await vi.advanceTimersByTimeAsync(30_000);
      const outcome = await outcomePromise;

      expect(outcome.status).toBe('error');
      expect(sendMessageToTab).toHaveBeenCalledWith(TAB_ID, { type: 'TASK_COMPLETE' });
    } finally {
      vi.useRealTimers();
    }
  });
});
