import type { StreamingSTT, TranscriptCallback, DebugCallback } from './stt';

function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm;
}

export class Transcriber {
  private stt: StreamingSTT;
  private onDebug: DebugCallback;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;

  constructor(stt: StreamingSTT, onTranscript: TranscriptCallback, onDebug: DebugCallback = () => {}) {
    this.stt = stt;
    this.stt.onTranscript = onTranscript;
    this.stt.onDebug = onDebug;
    this.onDebug = onDebug;
  }

  async start(): Promise<void> {
    this.onDebug('Transcriber.start() — connecting STT + mic in parallel');

    // STT connect (token fetch + WS handshake kickoff) and mic acquisition run in
    // parallel — sequential ordering (old code) wasted ~300–600 ms on network
    // before the mic even opened, dropping the user's first words.
    const [, stream] = await Promise.all([
      this.stt.connect(),
      navigator.mediaDevices.getUserMedia({ audio: true }),
    ]);
    this.stream = stream;

    const tracks = this.stream.getAudioTracks().map(t => `${t.label}|enabled=${t.enabled}|muted=${t.muted}|state=${t.readyState}`).join('; ');
    this.onDebug(`getUserMedia OK: ${tracks}`);

    // Start audio capture immediately so the user can speak right away. Frames
    // recorded before the STT socket finishes its handshake are buffered by the
    // adapter (see StreamingSTT.sendAudio) so the first syllables aren't lost.
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    this.onDebug(`AudioContext created: state=${this.audioCtx.state} sampleRate=${this.audioCtx.sampleRate}`);
    // Offscreen documents have no user gesture — context starts suspended without this.
    await this.audioCtx.resume();
    this.onDebug(`AudioContext resumed: state=${this.audioCtx.state}`);
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm = float32ToPcm16(float32);
      this.stt.sendAudio(pcm.buffer);
    };

    source.connect(processor);
    processor.connect(this.audioCtx.destination);
    this.onDebug('ScriptProcessorNode connected — audio capture active');
  }

  stop(): void {
    this.stt.close();

    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;

    this.audioCtx?.close();
    this.audioCtx = null;
  }
}
