export type MessageType =
  | 'USER_QUERY'
  | 'TASK_STARTED'
  | 'TASK_COMPLETE'
  | 'PAUSE_REQUESTED'
  | 'PAUSE_AT_STEP'
  | 'RESUME'
  | 'ABORT'
  | 'NARRATION_DONE'
  | 'STOP_NARRATION'
  | 'TRANSCRIPT_PARTIAL'
  | 'TRANSCRIPT_FINAL';

export interface UserQueryPayload {
  text: string;
  screenshot?: string; // base64, only for visual questions
}

export interface PauseAtStepPayload {
  currentStep: number;
  totalSteps: number;
}

export interface TranscriptPayload {
  text: string;
  isFinal: boolean;
}

export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
}
