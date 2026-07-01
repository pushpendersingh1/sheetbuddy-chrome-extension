export type MessageType =
  | 'USER_QUERY'
  | 'OPEN_INPUT_BAR'
  | 'TASK_STARTED'
  | 'TASK_COMPLETE'
  | 'PAUSE_REQUESTED'
  | 'PAUSE_AT_STEP'
  | 'RESUME'
  | 'ABORT'
  | 'NARRATION_DONE'
  | 'STOP_NARRATION'
  | 'TRANSCRIPT_PARTIAL'
  | 'TRANSCRIPT_FINAL'
  | 'RUN_PRIMITIVE'
  | 'SPEAK'
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'DEBUG';

export interface UserQueryPayload {
  text: string;
  screenshot?: string; // base64, only for visual questions
}

export interface OpenInputBarPayload {
  mode: 'voice' | 'text' | 'both';
}

export interface PauseAtStepPayload {
  currentStep: number;
  totalSteps: number;
}

export interface TranscriptPayload {
  text: string;
  isFinal: boolean;
}

export interface SpeakPayload {
  text: string;
}

export interface RunPrimitivePayload {
  name: string;
  args?: unknown[];
}

export interface PrimitiveResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
}
