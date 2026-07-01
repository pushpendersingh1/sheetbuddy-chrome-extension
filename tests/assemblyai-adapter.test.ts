import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { AssemblyAIAdapter } from '../src/offscreen/assemblyai-adapter';

// ---- WebSocket stub ----

class WebSocketStub {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = WebSocketStub.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => { this.readyState = WebSocketStub.CLOSED; });

  constructor(url: string) {
    this.url = url;
    WebSocketStub.lastInstance = this;
  }

  static lastInstance: WebSocketStub;

  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateOpen() {
    this.readyState = WebSocketStub.OPEN;
    this.onopen?.();
  }
}

Object.defineProperty(globalThis, 'WebSocket', { value: WebSocketStub, writable: true });

// ---- fetch stub ----

const TOKEN = 'test-token-abc123';
const WORKER_URL = 'https://worker.example.com';

function makeFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ token: TOKEN }),
  }));
}

describe('AssemblyAIAdapter', () => {
  let adapter: AssemblyAIAdapter;
  let onTranscript: MockInstance;
  let fetchMock: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    WebSocketStub.lastInstance = undefined as unknown as WebSocketStub;
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    onTranscript = vi.fn();
    adapter = new AssemblyAIAdapter(WORKER_URL);
    adapter.onTranscript = onTranscript as unknown as (text: string, isFinal: boolean) => void;
    await adapter.connect();
  });

  describe('connect()', () => {
    it('fetches a token from POST /transcribe-token', () => {
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${WORKER_URL}/transcribe-token`);
      expect(opts.method).toBe('POST');
    });

    it('opens a WebSocket to the AssemblyAI v3 URL with the token', () => {
      const ws = WebSocketStub.lastInstance;
      expect(ws.url).toContain('wss://streaming.assemblyai.com/v3/ws');
      expect(ws.url).toContain(`token=${TOKEN}`);
      expect(ws.url).toContain('sample_rate=16000');
      expect(ws.url).toContain('encoding=pcm_s16le');
      expect(ws.url).toContain('speech_model=universal-streaming-english');
    });

    it('rejects when token request returns non-200', async () => {
      const failFetch = vi.fn(async () => ({ ok: false, status: 429 }));
      globalThis.fetch = failFetch as unknown as typeof fetch;
      const a = new AssemblyAIAdapter(WORKER_URL);
      await expect(a.connect()).rejects.toThrow('Token request failed: 429');
    });
  });

  describe('onmessage — v3 Turn format', () => {
    it('fires onTranscript with isFinal=false on Turn with end_of_turn=false', () => {
      WebSocketStub.lastInstance.simulateMessage({ type: 'Turn', transcript: 'hello', end_of_turn: false });
      expect(onTranscript).toHaveBeenCalledWith('hello', false);
    });

    it('fires onTranscript with isFinal=true on Turn with end_of_turn=true', () => {
      WebSocketStub.lastInstance.simulateMessage({ type: 'Turn', transcript: 'hello world', end_of_turn: true });
      expect(onTranscript).toHaveBeenCalledWith('hello world', true);
    });

    it('does not fire onTranscript on Turn with empty transcript', () => {
      WebSocketStub.lastInstance.simulateMessage({ type: 'Turn', transcript: '', end_of_turn: false });
      expect(onTranscript).not.toHaveBeenCalled();
    });

    it('does not fire onTranscript on a Begin session-init message', () => {
      WebSocketStub.lastInstance.simulateMessage({ type: 'Begin' });
      expect(onTranscript).not.toHaveBeenCalled();
    });
  });

  describe('onmessage — v2 legacy format', () => {
    it('fires onTranscript with isFinal=false on PartialTranscript', () => {
      WebSocketStub.lastInstance.simulateMessage({ message_type: 'PartialTranscript', text: 'hello' });
      expect(onTranscript).toHaveBeenCalledWith('hello', false);
    });

    it('fires onTranscript with isFinal=true on FinalTranscript', () => {
      WebSocketStub.lastInstance.simulateMessage({ message_type: 'FinalTranscript', text: 'hello world' });
      expect(onTranscript).toHaveBeenCalledWith('hello world', true);
    });

    it('ignores unknown message types without calling onTranscript', () => {
      WebSocketStub.lastInstance.simulateMessage({ message_type: 'SessionBegins', session_id: '123' });
      expect(onTranscript).not.toHaveBeenCalled();
    });
  });

  describe('sendAudio()', () => {
    it('sends PCM buffer to the WebSocket when OPEN', () => {
      const pcm = new ArrayBuffer(8);
      adapter.sendAudio(pcm);
      expect(WebSocketStub.lastInstance.send).toHaveBeenCalledWith(pcm);
    });

    it('buffers PCM chunks while the WebSocket is CONNECTING, does not send them yet', () => {
      WebSocketStub.lastInstance.readyState = WebSocketStub.CONNECTING;
      const pcm = new ArrayBuffer(8);
      adapter.sendAudio(pcm);
      expect(WebSocketStub.lastInstance.send).not.toHaveBeenCalled();
    });

    it('flushes buffered chunks in order once the WebSocket opens', () => {
      WebSocketStub.lastInstance.readyState = WebSocketStub.CONNECTING;
      const first = new ArrayBuffer(8);
      const second = new ArrayBuffer(8);
      adapter.sendAudio(first);
      adapter.sendAudio(second);
      expect(WebSocketStub.lastInstance.send).not.toHaveBeenCalled();

      WebSocketStub.lastInstance.simulateOpen();

      expect(WebSocketStub.lastInstance.send).toHaveBeenNthCalledWith(1, first);
      expect(WebSocketStub.lastInstance.send).toHaveBeenNthCalledWith(2, second);
    });

    it('drops chunks once the CONNECTING buffer cap (20) is reached', () => {
      WebSocketStub.lastInstance.readyState = WebSocketStub.CONNECTING;
      for (let i = 0; i < 25; i++) adapter.sendAudio(new ArrayBuffer(8));

      WebSocketStub.lastInstance.simulateOpen();

      expect(WebSocketStub.lastInstance.send).toHaveBeenCalledTimes(20);
    });

    it('does nothing when WebSocket is CLOSED', () => {
      WebSocketStub.lastInstance.readyState = WebSocketStub.CLOSED;
      adapter.sendAudio(new ArrayBuffer(8));
      expect(WebSocketStub.lastInstance.send).not.toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('closes the WebSocket without sending any frame (v3 closes socket directly)', () => {
      adapter.close();
      expect(WebSocketStub.lastInstance.send).not.toHaveBeenCalled();
      expect(WebSocketStub.lastInstance.close).toHaveBeenCalled();
    });

    it('does not close if WebSocket is already CLOSED', () => {
      WebSocketStub.lastInstance.readyState = WebSocketStub.CLOSED;
      adapter.close();
      expect(WebSocketStub.lastInstance.close).not.toHaveBeenCalled();
    });

    it('closes a CONNECTING WebSocket without sending terminate_session', () => {
      WebSocketStub.lastInstance.readyState = WebSocketStub.CONNECTING;
      adapter.close();
      expect(WebSocketStub.lastInstance.close).toHaveBeenCalled();
      expect(WebSocketStub.lastInstance.send).not.toHaveBeenCalled();
    });
  });
});
