import { describe, it, expect, vi } from 'vitest';
import { makeTranscriptPipeline, type TranscriberLike } from '../src/offscreen/pipeline';
import type { Message } from '../src/types/messages';

type TranscriptCb = (text: string, isFinal: boolean) => void;
type DebugCb = (msg: string) => void;

function makeFakeTranscriber(opts: { failStartTimes?: number; startError?: string } = {}) {
  let started = false;
  let stopped = false;
  let startAttempts = 0;
  let capturedOnTranscript: TranscriptCb = () => {};
  let capturedOnDebug: DebugCb = () => {};

  const createTranscriber = vi.fn((onTranscript: TranscriptCb, onDebug: DebugCb): TranscriberLike => {
    capturedOnTranscript = onTranscript;
    capturedOnDebug = onDebug;
    return {
      start: vi.fn(async () => {
        startAttempts++;
        if (startAttempts <= (opts.failStartTimes ?? 0)) throw new Error(opts.startError ?? 'start failed');
        started = true;
      }),
      stop: vi.fn(() => { stopped = true; }),
    };
  });

  return {
    createTranscriber,
    emitTranscript: (text: string, isFinal: boolean) => capturedOnTranscript(text, isFinal),
    emitDebug: (msg: string) => capturedOnDebug(msg),
    get started() { return started; },
    get stopped() { return stopped; },
  };
}

describe('makeTranscriptPipeline', () => {
  it('constructs a transcriber and starts it on startRecording()', async () => {
    const fake = makeFakeTranscriber();
    const sendMessage = vi.fn();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage });

    const result = await pipeline.startRecording();

    expect(result).toEqual({ ok: true });
    expect(fake.createTranscriber).toHaveBeenCalledTimes(1);
    expect(fake.started).toBe(true);
  });

  it('forwards partial transcripts as TRANSCRIPT_PARTIAL', async () => {
    const fake = makeFakeTranscriber();
    const sendMessage = vi.fn();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage });
    await pipeline.startRecording();

    fake.emitTranscript('hello wor', false);

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'TRANSCRIPT_PARTIAL',
      payload: { text: 'hello wor', isFinal: false },
    } satisfies Message);
  });

  it('forwards final transcripts as TRANSCRIPT_FINAL', async () => {
    const fake = makeFakeTranscriber();
    const sendMessage = vi.fn();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage });
    await pipeline.startRecording();

    fake.emitTranscript('hello world', true);

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'TRANSCRIPT_FINAL',
      payload: { text: 'hello world', isFinal: true },
    } satisfies Message);
  });

  it('forwards debug messages', async () => {
    const fake = makeFakeTranscriber();
    const sendMessage = vi.fn();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage });
    await pipeline.startRecording();

    fake.emitDebug('getUserMedia OK');

    expect(sendMessage).toHaveBeenCalledWith({ type: 'DEBUG', payload: { msg: 'getUserMedia OK' } });
  });

  it('rejects a second startRecording() while one is already active', async () => {
    const fake = makeFakeTranscriber();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage: vi.fn() });
    await pipeline.startRecording();

    const second = await pipeline.startRecording();

    expect(second).toEqual({ ok: false, error: 'Already recording' });
    expect(fake.createTranscriber).toHaveBeenCalledTimes(1);
  });

  it('allows a new recording after stopRecording() clears the active transcriber', async () => {
    const fake = makeFakeTranscriber();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage: vi.fn() });
    await pipeline.startRecording();

    pipeline.stopRecording();
    const result = await pipeline.startRecording();

    expect(result).toEqual({ ok: true });
    expect(fake.createTranscriber).toHaveBeenCalledTimes(2);
  });

  it('calls stop() on the active transcriber and clears it', async () => {
    const fake = makeFakeTranscriber();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage: vi.fn() });
    await pipeline.startRecording();

    pipeline.stopRecording();

    expect(fake.stopped).toBe(true);
  });

  it('does not throw when stopRecording() is called with nothing active', () => {
    const fake = makeFakeTranscriber();
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage: vi.fn() });

    expect(() => pipeline.stopRecording()).not.toThrow();
  });

  it("clears the active transcriber and reports the error when start() rejects", async () => {
    const fake = makeFakeTranscriber({ failStartTimes: 1, startError: 'getUserMedia denied' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipeline = makeTranscriptPipeline({ createTranscriber: fake.createTranscriber, sendMessage: vi.fn() });

    const result = await pipeline.startRecording();

    // Matches the pre-extraction String(err) wire format (e.g. "Error: getUserMedia denied"),
    // not just err.message — this is a public response payload other contexts read.
    expect(result).toEqual({ ok: false, error: 'Error: getUserMedia denied' });
    // A failed start must clear the slot so the next attempt isn't blocked by
    // "Already recording".
    const retry = await pipeline.startRecording();
    expect(retry.ok).toBe(true);
    errorSpy.mockRestore();
  });
});
