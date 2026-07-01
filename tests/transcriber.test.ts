import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { Transcriber } from '../src/offscreen/transcriber';
import type { StreamingSTT, TranscriptCallback, DebugCallback } from '../src/offscreen/stt';

// ---- InMemorySTT — in-process test double, no WebSocket or fetch globals needed ----

class InMemorySTT implements StreamingSTT {
  frames: ArrayBuffer[] = [];
  onTranscript: TranscriptCallback = () => {};
  onDebug: DebugCallback = () => {};
  connectCalled = false;
  closeCalled = false;

  connect() {
    this.connectCalled = true;
    return Promise.resolve();
  }

  sendAudio(pcm: ArrayBuffer) {
    this.frames.push(pcm);
  }

  close() {
    this.closeCalled = true;
  }

  simulateTranscript(text: string, isFinal: boolean) {
    this.onTranscript(text, isFinal);
  }
}

// ---- MediaStream stub ----

function makeTrackStub() {
  return { stop: vi.fn(), kind: 'audio', label: 'Mic', enabled: true, muted: false, readyState: 'live' };
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
  static lastInstance: AudioContextStub;
  state = 'suspended';
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
  constructor() {
    AudioContextStub.lastInstance = this;
  }
}

Object.defineProperty(globalThis, 'AudioContext', { value: AudioContextStub, writable: true });

describe('Transcriber', () => {
  let stt: InMemorySTT;
  let transcriber: Transcriber;
  let onTranscript: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    streamStub._tracks[0].stop.mockReset?.();
    onTranscript = vi.fn();
    stt = new InMemorySTT();
    transcriber = new Transcriber(stt, onTranscript as unknown as TranscriptCallback);
    await transcriber.start();
  });

  it('calls stt.connect() on start()', () => {
    expect(stt.connectCalled).toBe(true);
  });

  it('calls getUserMedia for audio', () => {
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('creates AudioContext and calls resume() for offscreen document', () => {
    expect(AudioContextStub.lastInstance.resume).toHaveBeenCalled();
  });

  it('fires onTranscript when stt emits a partial transcript', () => {
    stt.simulateTranscript('hello', false);
    expect(onTranscript).toHaveBeenCalledWith('hello', false);
  });

  it('fires onTranscript when stt emits a final transcript', () => {
    stt.simulateTranscript('hello world', true);
    expect(onTranscript).toHaveBeenCalledWith('hello world', true);
  });

  it('wires onDebug through to the stt adapter', async () => {
    const onDebug = vi.fn();
    const stt2 = new InMemorySTT();
    const t = new Transcriber(stt2, vi.fn() as unknown as TranscriptCallback, onDebug as unknown as DebugCallback);
    await t.start();
    expect(stt2.onDebug).toBe(onDebug);
    expect(onDebug).toHaveBeenCalled();
  });

  describe('stop()', () => {
    it('calls stt.close()', () => {
      transcriber.stop();
      expect(stt.closeCalled).toBe(true);
    });

    it('stops all mic tracks', () => {
      transcriber.stop();
      for (const track of streamStub._tracks) {
        expect(track.stop).toHaveBeenCalled();
      }
    });

    it('calls audioCtx.close()', () => {
      transcriber.stop();
      expect(AudioContextStub.lastInstance.close).toHaveBeenCalled();
    });
  });

  describe('start() error handling', () => {
    it('propagates getUserMedia rejection', async () => {
      const failSTT = new InMemorySTT();
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Permission denied'),
      );
      const t = new Transcriber(failSTT, vi.fn() as unknown as TranscriptCallback);
      await expect(t.start()).rejects.toThrow('Permission denied');
    });
  });
});
