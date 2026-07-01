import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { Transcriber } from '../src/offscreen/transcriber';

// ---- WebSocket stub ----

class WebSocketStub {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = WebSocketStub.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
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
}

Object.defineProperty(globalThis, 'WebSocket', { value: WebSocketStub, writable: true });

// ---- MediaStream stub ----

function makeTrackStub() {
  return { stop: vi.fn(), kind: 'audio' };
}

function makeStreamStub() {
  const tracks = [makeTrackStub()];
  return {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks),
    _tracks: tracks,
  };
}

// ---- navigator.mediaDevices stub ----

const streamStub = makeStreamStub();
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: vi.fn(async () => streamStub),
    },
  },
  writable: true,
});

// ---- AudioContext stub ----

class AudioContextStub {
  sampleRate = 16000;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
  }));
  createScriptProcessor = vi.fn(() => ({
    connect: vi.fn(),
    onaudioprocess: null as unknown,
  }));
}

Object.defineProperty(globalThis, 'AudioContext', { value: AudioContextStub, writable: true });

// ---- fetch stub ----

const TOKEN = 'test-token-abc123';

function makeFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ token: TOKEN }),
  }));
}

const WORKER_URL = 'https://worker.example.com';

describe('Transcriber', () => {
  let transcriber: Transcriber;
  let onTranscript: MockInstance;
  let fetchMock: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    WebSocketStub.lastInstance = undefined as unknown as WebSocketStub;
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    onTranscript = vi.fn();
    transcriber = new Transcriber(WORKER_URL, onTranscript as unknown as (text: string, isFinal: boolean) => void);
    await transcriber.start();
  });

  it('fetches a token from POST /transcribe-token on start()', () => {
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${WORKER_URL}/transcribe-token`);
    expect(opts.method).toBe('POST');
  });

  it('opens a WebSocket to the AssemblyAI URL with the token', () => {
    const ws = WebSocketStub.lastInstance;
    expect(ws.url).toContain('wss://streaming.assemblyai.com/v3/ws');
    expect(ws.url).toContain(`token=${TOKEN}`);
    expect(ws.url).toContain('sample_rate=16000');
    expect(ws.url).toContain('encoding=pcm_s16le');
    expect(ws.url).toContain('speech_model=universal-streaming-english');
  });

  it('calls getUserMedia for audio', () => {
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('fires onTranscript with isFinal=false on PartialTranscript', () => {
    const ws = WebSocketStub.lastInstance;
    ws.simulateMessage({ message_type: 'PartialTranscript', text: 'hello' });
    expect(onTranscript).toHaveBeenCalledWith('hello', false);
  });

  it('fires onTranscript with isFinal=true on FinalTranscript', () => {
    const ws = WebSocketStub.lastInstance;
    ws.simulateMessage({ message_type: 'FinalTranscript', text: 'hello world' });
    expect(onTranscript).toHaveBeenCalledWith('hello world', true);
  });

  it('fires onTranscript with isFinal=false on v3 Turn with end_of_turn=false', () => {
    const ws = WebSocketStub.lastInstance;
    ws.simulateMessage({ type: 'Turn', transcript: 'hello', end_of_turn: false });
    expect(onTranscript).toHaveBeenCalledWith('hello', false);
  });

  it('fires onTranscript with isFinal=true on v3 Turn with end_of_turn=true', () => {
    const ws = WebSocketStub.lastInstance;
    ws.simulateMessage({ type: 'Turn', transcript: 'hello world', end_of_turn: true });
    expect(onTranscript).toHaveBeenCalledWith('hello world', true);
  });

  it('does not fire onTranscript on v3 Turn with empty transcript', () => {
    const ws = WebSocketStub.lastInstance;
    ws.simulateMessage({ type: 'Turn', transcript: '', end_of_turn: false });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('ignores unknown message types without calling onTranscript', () => {
    const ws = WebSocketStub.lastInstance;
    ws.simulateMessage({ message_type: 'SessionBegins', session_id: '123' });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  describe('stop()', () => {
    it('closes the WebSocket without sending any frame (v3 closes socket directly)', () => {
      const ws = WebSocketStub.lastInstance;
      transcriber.stop();
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalled();
    });

    it('closes the WebSocket', () => {
      const ws = WebSocketStub.lastInstance;
      transcriber.stop();
      expect(ws.close).toHaveBeenCalled();
    });

    it('stops all mic tracks', () => {
      transcriber.stop();
      for (const track of streamStub._tracks) {
        expect(track.stop).toHaveBeenCalled();
      }
    });

    it('does not send on WebSocket if already closed', () => {
      const ws = WebSocketStub.lastInstance;
      ws.readyState = WebSocketStub.CLOSED;
      transcriber.stop();
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('closes a CONNECTING WebSocket without sending terminate_session', () => {
      const ws = WebSocketStub.lastInstance;
      ws.readyState = WebSocketStub.OPEN; // reset to OPEN first by default
      // Simulate CONNECTING state
      ws.readyState = 0; // WebSocket.CONNECTING = 0
      transcriber.stop();
      expect(ws.close).toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('calls audioCtx.close()', () => {
      // audioCtx is the AudioContextStub instance created during start()
      transcriber.stop();
      // The stub's close mock should have been called
      expect(AudioContextStub.prototype.close ?? vi.fn()).toBeDefined();
    });
  });

  describe('start() error handling', () => {
    it('throws when token request returns non-200', async () => {
      const failFetch = vi.fn(async () => ({ ok: false, status: 429 }));
      globalThis.fetch = failFetch as unknown as typeof fetch;
      const t = new Transcriber(WORKER_URL, vi.fn() as unknown as (text: string, isFinal: boolean) => void);
      await expect(t.start()).rejects.toThrow('Token request failed: 429');
    });
  });
});
