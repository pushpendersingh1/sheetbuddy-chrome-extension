export type TranscriptCallback = (text: string, isFinal: boolean) => void;
export type DebugCallback = (msg: string) => void;

function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm;
}

export class Transcriber {
  private workerUrl: string;
  private onTranscript: TranscriptCallback;
  private onDebug: DebugCallback;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;

  constructor(workerUrl: string, onTranscript: TranscriptCallback, onDebug: DebugCallback = () => {}) {
    this.workerUrl = workerUrl;
    this.onTranscript = onTranscript;
    this.onDebug = onDebug;
  }

  async start(): Promise<void> {
    console.log('[SheetBuddy] Transcriber.start() — fetching token + mic in parallel');

    // Fetch the token and acquire the mic in parallel — neither depends on the other.
    // Sequential ordering (old code) wasted ~300–600 ms on network before the mic
    // even opened, dropping the user's first words.
    const [res, stream] = await Promise.all([
      fetch(`${this.workerUrl}/transcribe-token`, { method: 'POST' }),
      navigator.mediaDevices.getUserMedia({ audio: true }),
    ]);
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    const { token } = await res.json() as { token: string };
    this.stream = stream;

    const tracks = this.stream.getAudioTracks().map(t => `${t.label}|enabled=${t.enabled}|muted=${t.muted}|state=${t.readyState}`).join('; ');
    this.onDebug(`getUserMedia OK: ${tracks}`);

    // Start audio capture immediately so the user can speak right away.
    // PCM chunks captured before the WebSocket handshake completes (~300–500 ms)
    // are buffered and flushed once the socket opens, so the first syllables
    // are not lost.
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    this.onDebug(`AudioContext created: state=${this.audioCtx.state} sampleRate=${this.audioCtx.sampleRate}`);
    // Offscreen documents have no user gesture — context starts suspended without this.
    await this.audioCtx.resume();
    this.onDebug(`AudioContext resumed: state=${this.audioCtx.state}`);
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    // Holds PCM chunks recorded before the socket opens (capped at ~5 s).
    const preOpenBuffer: ArrayBufferLike[] = [];
    let chunksSent = 0;
    let chunksBuffered = 0;
    let chunksDropped = 0;

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm = float32ToPcm16(float32);
      const wsState = this.ws?.readyState;
      if (wsState === WebSocket.OPEN) {
        this.ws!.send(pcm.buffer);
        chunksSent++;
        if (chunksSent === 1 || chunksSent === 5 || chunksSent === 20) {
          this.onDebug(`audio chunk #${chunksSent} sent OK (${pcm.buffer.byteLength}B)`);
        }
      } else if (wsState === WebSocket.CONNECTING && preOpenBuffer.length < 20) {
        preOpenBuffer.push(pcm.buffer);
        chunksBuffered++;
        if (chunksBuffered === 1) this.onDebug(`buffering chunk #1 (WS still connecting)`);
      } else {
        chunksDropped++;
        if (chunksDropped === 1) this.onDebug(`DROPPED chunk #1 — WS state=${wsState}`);
      }
    };

    source.connect(processor);
    processor.connect(this.audioCtx.destination);
    this.onDebug('ScriptProcessorNode connected — audio capture active');

    // speech_model is required for v3; without it the server closes the socket immediately
    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?token=${token}&sample_rate=16000&encoding=pcm_s16le&speech_model=universal-streaming-english`;
    this.onDebug('Opening WebSocket...');
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.onDebug(`WS onopen — flushing ${preOpenBuffer.length} buffered chunks`);
      // Flush audio buffered during handshake
      for (const chunk of preOpenBuffer) this.ws!.send(chunk);
      preOpenBuffer.length = 0;
    };

    this.ws.onerror = () => {
      this.onDebug('WS onerror fired');
      preOpenBuffer.length = 0;
    };

    this.ws.onclose = (event) => {
      this.onDebug(`WS closed: code=${event.code} reason="${event.reason}" chunksSent=${chunksSent}`);
    };

    this.ws.onmessage = (event) => {
      const raw = event.data as string;
      this.onDebug(`WS msg: ${raw.slice(0, 120)}`);
      const data = JSON.parse(raw) as {
        // v3 Universal Streaming format
        type?: string;
        transcript?: string;
        end_of_turn?: boolean;
        // v2 legacy format (fallback)
        message_type?: string;
        text?: string;
      };

      // v3: Turn messages with end_of_turn flag
      if (data.type === 'Turn') {
        const text = data.transcript ?? '';
        if (text) this.onTranscript(text, data.end_of_turn ?? false);
        return;
      }

      // v3: Begin is a session-init acknowledgement, nothing to do
      if (data.type === 'Begin') return;

      // v2 fallback
      if (data.message_type === 'PartialTranscript') {
        this.onTranscript(data.text ?? '', false);
      } else if (data.message_type === 'FinalTranscript') {
        this.onTranscript(data.text ?? '', true);
      } else {
        this.onDebug(`unrecognized msg: ${JSON.stringify(data).slice(0, 80)}`);
      }
    };
    this.onDebug('start() complete — WS connecting');
  }

  stop(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      // v3: just close the socket — no terminate_session JSON needed
      this.ws.close();
    }
    this.ws = null;

    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;

    this.audioCtx?.close();
    this.audioCtx = null;
  }
}
