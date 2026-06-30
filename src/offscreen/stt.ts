export type TranscriptCallback = (text: string, isFinal: boolean) => void;

export interface StreamingSTT {
  onTranscript: TranscriptCallback;
  connect(): Promise<void>;
  sendAudio(pcm: ArrayBuffer): void;
  close(): void;
}
