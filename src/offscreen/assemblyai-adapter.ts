import type { StreamingSTT, TranscriptCallback } from './stt';

export class AssemblyAIAdapter implements StreamingSTT {
  private workerUrl: string;
  private ws: WebSocket | null = null;
  onTranscript: TranscriptCallback = () => {};

  constructor(workerUrl: string) {
    this.workerUrl = workerUrl;
  }

  async connect(): Promise<void> {
    const res = await fetch(`${this.workerUrl}/transcribe-token`, { method: 'POST' });
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    const { token } = await res.json() as { token: string };

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
      } else {
        // Unrecognized format — log so future API changes are immediately visible
        console.warn('[SheetBuddy] Unrecognized AssemblyAI message:', JSON.stringify(data));
      }
    };
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ terminate_session: true }));
      }
      this.ws.close();
    }
    this.ws = null;
  }
}
