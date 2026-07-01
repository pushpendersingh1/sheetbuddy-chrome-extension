export interface Narrator {
  speak(text: string): Promise<void>;
}

interface PlaybackHandle {
  audio: HTMLAudioElement;
  url: string;
  resolve: () => void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class TTSNarrator implements Narrator {
  private workerUrl: string;
  // chrome.storage is not available in offscreen documents — use in-memory cache instead.
  // Cleared automatically when the offscreen document is destroyed (same lifetime as session storage).
  private cache = new Map<string, string>();
  // Tracks the in-flight playback so stop() has something to interrupt.
  private current: PlaybackHandle | null = null;

  constructor(workerUrl: string) {
    this.workerUrl = workerUrl;
  }

  async speak(text: string): Promise<void> {
    let audioData = this.cache.get(text);

    if (!audioData) {
      const res = await fetch(`${this.workerUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`TTS request failed: ${res.status}`);
      const buffer = await res.arrayBuffer();
      audioData = arrayBufferToBase64(buffer);
      this.cache.set(text, audioData);
    }

    const buffer = base64ToArrayBuffer(audioData);
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    return new Promise<void>((resolve, reject) => {
      this.current = { audio, url, resolve };
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.current = null;
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        this.current = null;
        reject(new Error('Audio playback failed'));
      };
      audio.play().catch(reject);
    });
  }

  // Called when PAUSE_REQUESTED interrupts narration mid-playback. Resolves the
  // pending speak() promise rather than rejecting it — being stopped by a pause
  // is expected, successful behavior, not a playback failure.
  stop(): void {
    if (!this.current) return;
    const { audio, url, resolve } = this.current;
    audio.pause();
    URL.revokeObjectURL(url);
    this.current = null;
    resolve();
  }
}
