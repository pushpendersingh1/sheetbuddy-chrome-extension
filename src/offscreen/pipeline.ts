import type { Message, PrimitiveResult, TranscriptPayload } from '../types/messages';

export interface TranscriberLike {
  start(): Promise<void>;
  stop(): void;
}

export interface TranscriptPipelineDeps {
  createTranscriber: (
    onTranscript: (text: string, isFinal: boolean) => void,
    onDebug: (msg: string) => void,
  ) => TranscriberLike;
  sendMessage: (message: Message) => void;
}

// Owns the transcript pipeline's lifecycle: constructing a fresh Transcriber per
// recording session, forwarding partial/final transcripts and debug lines to
// every extension context, and guarding against a second START_RECORDING while
// one is already active. Deps are injected so this is unit-testable without a
// real STT/mic, mirroring relay.ts/sheet-plan.ts.
export function makeTranscriptPipeline(deps: TranscriptPipelineDeps) {
  const { createTranscriber, sendMessage } = deps;

  // Closure-scoped (not module-scope) so each makeTranscriptPipeline(...) instance
  // — e.g. each test — gets independent state, mirroring relay.ts's offscreenPromise.
  let transcriber: TranscriberLike | null = null;

  async function startRecording(): Promise<PrimitiveResult> {
    if (transcriber) {
      return { ok: false, error: 'Already recording' };
    }

    const instance = createTranscriber(
      (text, isFinal) => {
        const payload: TranscriptPayload = { text, isFinal };
        sendMessage({ type: isFinal ? 'TRANSCRIPT_FINAL' : 'TRANSCRIPT_PARTIAL', payload });
      },
      (msg) => {
        sendMessage({ type: 'DEBUG', payload: { msg } });
      },
    );
    transcriber = instance;

    try {
      await instance.start();
      return { ok: true };
    } catch (err) {
      transcriber = null;
      console.error('[SheetBuddy] Recording start error:', err);
      return { ok: false, error: String(err) };
    }
  }

  function stopRecording(): void {
    transcriber?.stop();
    transcriber = null;
  }

  return { startRecording, stopRecording };
}
