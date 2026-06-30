import type { StreamingSTT, TranscriptCallback } from './stt';

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
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;

  constructor(stt: StreamingSTT, onTranscript: TranscriptCallback) {
    this.stt = stt;
    this.stt.onTranscript = onTranscript;
  }

  async start(): Promise<void> {
    await this.stt.connect();

    // Acquire mic after STT is connected — if permission denied, no dangling socket
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    // Offscreen documents have no user gesture — context starts suspended without this
    await this.audioCtx.resume();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm = float32ToPcm16(float32);
      this.stt.sendAudio(pcm.buffer);
    };

    source.connect(processor);
    processor.connect(this.audioCtx.destination);
  }

  stop(): void {
    this.stt.close();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.audioCtx?.close();
    this.audioCtx = null;
  }
}
