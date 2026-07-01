import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { TTSNarrator } from '../src/offscreen/narrator';

// ---- Audio stub ----

class AudioStub {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(() => {
    Promise.resolve().then(() => this.onended?.());
    return Promise.resolve();
  });
  constructor(src: string) { this.src = src; }
}

// A play() that never auto-resolves onended — lets a test call stop() mid-playback.
class NeverEndingAudioStub {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(() => Promise.resolve());
  constructor(src: string) { this.src = src; }
}

Object.defineProperty(globalThis, 'Audio', { value: AudioStub, writable: true });

// ---- URL stubs ----

Object.defineProperty(globalThis, 'URL', {
  value: {
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
  },
  writable: true,
});

// ---- fetch stub ----

function makeFetchMock(audioBytes: Uint8Array) {
  return vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => audioBytes.buffer,
  }));
}

const WORKER_URL = 'https://worker.example.com';
const SAMPLE_AUDIO = new Uint8Array([0x49, 0x44, 0x33]); // fake MP3 header bytes

describe('TTSNarrator', () => {
  let narrator: TTSNarrator;
  let fetchMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();

    (URL as unknown as { createObjectURL: MockInstance }).createObjectURL = vi.fn(() => 'blob:fake-url');
    (URL as unknown as { revokeObjectURL: MockInstance }).revokeObjectURL = vi.fn();

    fetchMock = makeFetchMock(SAMPLE_AUDIO);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    narrator = new TTSNarrator(WORKER_URL);
  });

  it('calls POST /tts with the text on first speak', async () => {
    await narrator.speak('Hello SheetBuddy');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${WORKER_URL}/tts`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ text: 'Hello SheetBuddy' });
  });

  it('resolves after audio ends, confirming play() was called', async () => {
    // speak() only resolves when audio.onended fires, which the stub triggers after play()
    await expect(narrator.speak('Hello SheetBuddy')).resolves.toBeUndefined();
  });

  it('resolves only after audio ends', async () => {
    const order: string[] = [];
    const p = narrator.speak('Hello').then(() => order.push('resolved'));
    order.push('speaking');
    await p;
    order.push('after');
    expect(order).toEqual(['speaking', 'resolved', 'after']);
  });

  it('stores audio in the in-memory cache after fetch', async () => {
    await narrator.speak('Cache me');
    // cache is private — verify indirectly: a second call must not fetch
    await narrator.speak('Cache me');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does NOT call fetch on second speak with same text (cache hit)', async () => {
    await narrator.speak('Cached phrase');
    expect(fetchMock).toHaveBeenCalledOnce();

    await narrator.speak('Cached phrase');
    expect(fetchMock).toHaveBeenCalledOnce(); // still once — no second call
  });

  it('calls fetch again for a different phrase', async () => {
    await narrator.speak('Phrase A');
    await narrator.speak('Phrase B');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects and does NOT cache when fetch returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(narrator.speak('Error phrase')).rejects.toThrow('TTS request failed: 429');
    // cache miss must not persist — a retry should hit fetch again
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await narrator.speak('Error phrase');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  describe('stop', () => {
    it('does nothing when nothing is playing', () => {
      expect(() => narrator.stop()).not.toThrow();
    });

    it('resolves the pending speak() promise (not reject) when stopped mid-playback', async () => {
      Object.defineProperty(globalThis, 'Audio', { value: NeverEndingAudioStub, writable: true });
      const speakPromise = narrator.speak('Interrupt me');
      // let the fetch/cache microtasks settle so audio.play() has been called
      await vi.waitFor(() => expect(URL.createObjectURL as unknown as MockInstance).toHaveBeenCalled());

      narrator.stop();

      await expect(speakPromise).resolves.toBeUndefined();
      Object.defineProperty(globalThis, 'Audio', { value: AudioStub, writable: true });
    });

    it('pauses the underlying Audio element when stopped', async () => {
      let createdAudio: NeverEndingAudioStub | undefined;
      class TrackedAudio extends NeverEndingAudioStub {
        constructor(src: string) { super(src); createdAudio = this; }
      }
      Object.defineProperty(globalThis, 'Audio', { value: TrackedAudio, writable: true });

      const speakPromise = narrator.speak('Interrupt me');
      await vi.waitFor(() => expect(createdAudio).toBeDefined());

      narrator.stop();
      await speakPromise;

      expect(createdAudio!.pause).toHaveBeenCalledOnce();
      Object.defineProperty(globalThis, 'Audio', { value: AudioStub, writable: true });
    });

    it('a second stop() call after playback already ended is a no-op', async () => {
      await narrator.speak('Already done');
      expect(() => narrator.stop()).not.toThrow();
    });
  });
});
