export type TranscriptCallback = (text: string, isFinal: boolean) => void;

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
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;

  constructor(workerUrl: string, onTranscript: TranscriptCallback) {
    this.workerUrl = workerUrl;
    this.onTranscript = onTranscript;
  }

  async start(): Promise<void> {
    const res = await fetch(`${this.workerUrl}/transcribe-token`, { method: 'POST' });
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    const { token } = await res.json() as { token: string };

    // Acquire mic before opening the WebSocket — if permission is denied, no socket is created
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // speech_model is required for v3; without it the server closes the socket immediately
    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?token=${token}&sample_rate=16000&encoding=pcm_s16le&speech_model=universal-streaming-english`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[SheetBuddy] AssemblyAI WebSocket connected');
    };

    this.ws.onerror = (event) => {
      console.error('[SheetBuddy] AssemblyAI WebSocket error:', event);
    };

    this.ws.onclose = (event) => {
      console.log('[SheetBuddy] AssemblyAI WebSocket closed:', event.code, event.reason);
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as {
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

      // v2 fallback
      if (data.message_type === 'PartialTranscript') {
        this.onTranscript(data.text ?? '', false);
      } else if (data.message_type === 'FinalTranscript') {
        this.onTranscript(data.text ?? '', true);
      }
    };

    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    // Offscreen documents have no user gesture — context starts suspended without this.
    await this.audioCtx.resume();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const float32 = e.inputBuffer.getChannelData(0);
        const pcm = float32ToPcm16(float32);
        this.ws.send(pcm.buffer);
      }
    };

    source.connect(processor);
    processor.connect(this.audioCtx.destination);
  }

  stop(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ terminate_session: true }));
      }
      this.ws.close();
    }
    this.ws = null;

    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;

    this.audioCtx?.close();
    this.audioCtx = null;
  }
}
