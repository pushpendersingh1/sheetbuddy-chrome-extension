import type { StreamingSTT, TranscriptCallback, DebugCallback } from './stt';

export class AssemblyAIAdapter implements StreamingSTT {
  private workerUrl: string;
  private ws: WebSocket | null = null;
  // Holds PCM chunks recorded before the socket opens (capped at ~5 s).
  private preOpenBuffer: ArrayBufferLike[] = [];
  private chunksSent = 0;
  private chunksBuffered = 0;
  private chunksDropped = 0;
  onTranscript: TranscriptCallback = () => {};
  onDebug: DebugCallback = () => {};

  constructor(workerUrl: string) {
    this.workerUrl = workerUrl;
  }

  async connect(): Promise<void> {
    const res = await fetch(`${this.workerUrl}/transcribe-token`, { method: 'POST' });
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    const { token } = await res.json() as { token: string };

    // speech_model is required for v3; without it the server closes the socket immediately
    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?token=${token}&sample_rate=16000&encoding=pcm_s16le&speech_model=universal-streaming-english`;
    this.onDebug('Opening WebSocket...');
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.onDebug(`WS onopen — flushing ${this.preOpenBuffer.length} buffered chunks`);
      // Flush audio buffered during handshake
      for (const chunk of this.preOpenBuffer) this.ws!.send(chunk);
      this.preOpenBuffer.length = 0;
    };

    this.ws.onerror = () => {
      this.onDebug('WS onerror fired');
      this.preOpenBuffer.length = 0;
    };

    this.ws.onclose = (event) => {
      this.onDebug(`WS closed: code=${event.code} reason="${event.reason}" chunksSent=${this.chunksSent}`);
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
  }

  sendAudio(pcm: ArrayBufferLike): void {
    const wsState = this.ws?.readyState;
    if (wsState === WebSocket.OPEN) {
      this.ws!.send(pcm);
      this.chunksSent++;
      if (this.chunksSent === 1 || this.chunksSent === 5 || this.chunksSent === 20) {
        this.onDebug(`audio chunk #${this.chunksSent} sent OK (${pcm.byteLength}B)`);
      }
    } else if (wsState === WebSocket.CONNECTING && this.preOpenBuffer.length < 20) {
      this.preOpenBuffer.push(pcm);
      this.chunksBuffered++;
      if (this.chunksBuffered === 1) this.onDebug('buffering chunk #1 (WS still connecting)');
    } else {
      this.chunksDropped++;
      if (this.chunksDropped === 1) this.onDebug(`DROPPED chunk #1 — WS state=${wsState}`);
    }
  }

  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      // v3: just close the socket — no terminate_session JSON needed
      this.ws.close();
    }
    this.ws = null;
  }
}
