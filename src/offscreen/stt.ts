export type TranscriptCallback = (text: string, isFinal: boolean) => void;
export type DebugCallback = (msg: string) => void;

export interface StreamingSTT {
  onTranscript: TranscriptCallback;
  onDebug: DebugCallback;
  connect(): Promise<void>;
  sendAudio(pcm: ArrayBufferLike): void;
  close(): void;
}
