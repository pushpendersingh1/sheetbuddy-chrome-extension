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

// chrome.runtime.sendMessage broadcasts to every extension context, so the
// offscreen document must distinguish messages background deliberately relayed
// to it from that broadcast noise. RelayedMessage is only ever constructed by
// background/relay.ts's relayToOffscreen — no other call site may stamp this.
export type RelayedMessage = Message & { _relayed: true };

// Mirrors worker/src/utils.ts's DOMContext — duplicated because the worker is a
// separate package with its own build, not because the shape is expected to diverge.
export interface DOMContext {
  activeCell: string;
  formulaBar: string;
  spreadsheetId: string;
  sheetGid: string;
  sheetName: string;
  columnHeaders: string[];
  availableSheets: string[];
}

export interface SheetStep {
  stepNumber: number;
  description: string;
  narration: string;
  primitive: string;
  args: Record<string, string>;
}

export interface SheetPlan {
  totalSteps: number;
  summary: string;
  steps: SheetStep[];
}
