import type { Message, RunPrimitivePayload, TranscriptPayload, OpenInputBarPayload, UserQueryPayload, PauseAtStepPayload, CursorMoveToPayload } from '../types/messages';
import { handlePrimitive } from './router';
import { SheetBuddyCreature } from './creature';
import { SheetBuddyCursor } from './cursor';
import { InputBar } from './input-bar';

console.log('[SheetBuddy] Content script loaded on', window.location.href);

const creature = new SheetBuddyCreature();
creature.mount();

const cursor = new SheetBuddyCursor();
cursor.mount();

const inputBar = new InputBar();
inputBar.mount();

// Exclude creature host from dismiss so mousedown-on-creature doesn't race with
// the toggle click: without this, mousedown closes the bar then click re-opens it.
const creatureHost = document.querySelector('#sheetbuddy-creature-host');
if (creatureHost) inputBar.dismissExclusions.push(creatureHost);

// Wire creature click → pause mid-execution (matches Escape below), otherwise
// toggle the input bar (open if closed, close if open).
creature.onClick = () => {
  if (creature.getState() === 'active') {
    chrome.runtime.sendMessage({ type: 'PAUSE_REQUESTED' }).catch((err: unknown) => {
      console.error('[SheetBuddy] Failed to send PAUSE_REQUESTED:', err);
    });
    return;
  }
  inputBar.toggle();
};

// Escape pauses mid-execution — capture phase so it fires before Sheets' own
// Escape handling (e.g. cancelling edit mode). isTrusted excludes the engine's
// own pressEscape() primitive, which dispatches a synthetic Escape as part of
// executing a step and must not self-trigger a pause.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.isTrusted && e.key === 'Escape' && creature.getState() === 'active') {
    chrome.runtime.sendMessage({ type: 'PAUSE_REQUESTED' }).catch((err: unknown) => {
      console.error('[SheetBuddy] Failed to send PAUSE_REQUESTED:', err);
    });
  }
}, true);

// Wire input bar callbacks → chrome messaging + creature state
// Debug element: content script writes here, main world reads via dataset
const dbg = document.createElement('div');
dbg.id = 'sheetbuddy-debug';
dbg.style.display = 'none';
document.body.appendChild(dbg);

inputBar.onStartRecording = () => {
  creature.setState('listening');
  dbg.dataset.startAck = 'pending';
  chrome.runtime.sendMessage({ type: 'START_RECORDING' })
    .then((resp: unknown) => {
      const r = resp as { ok: boolean; error?: string } | undefined;
      dbg.dataset.startAck = JSON.stringify(r);
      if (r?.ok) {
        // Mic + WS are live — transition button from "Starting..." to "Stop"
        inputBar.setMicReady();
      } else {
        inputBar.setMicError();
        creature.setState('idle');
      }
    })
    .catch((err: unknown) => {
      dbg.dataset.startAck = `catch:${String(err)}`;
      inputBar.setMicError();
      creature.setState('idle');
    });
};

inputBar.onStopRecording = () => {
  creature.setState('idle');
  // Safety unlock: if TRANSCRIPT_FINAL never arrives (e.g. no speech detected),
  // the field would otherwise stay locked. TRANSCRIPT_FINAL handler also calls
  // unlockField() — idempotent.
  inputBar.unlockField();
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch((err: unknown) => {
    console.error('[SheetBuddy] Failed to send STOP_RECORDING:', err);
  });
};

inputBar.onQuery = (text: string) => {
  creature.setState('thinking');
  chrome.runtime.sendMessage({ type: 'USER_QUERY', payload: { text } satisfies UserQueryPayload }).catch(
    (err: unknown) => {
      console.error('[SheetBuddy] Failed to send USER_QUERY:', err);
      creature.setState('idle');
    },
  );
};

inputBar.onDismiss = () => {
  creature.setState('idle');
};

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    if (message.type === 'RUN_PRIMITIVE') {
      const { name, args = [] } = (message.payload ?? {}) as RunPrimitivePayload;
      handlePrimitive(name, args).then(sendResponse);
      return true; // keep channel open for async response
    }

    if (message.type === 'TRANSCRIPT_PARTIAL') {
      const { text } = (message.payload ?? {}) as TranscriptPayload;
      dbg.dataset.lastPartial = text;
      dbg.dataset.transcriptCount = String(Number(dbg.dataset.transcriptCount ?? 0) + 1);
      inputBar.setTranscript(text);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'TRANSCRIPT_FINAL') {
      const { text } = (message.payload ?? {}) as TranscriptPayload;
      dbg.dataset.lastFinal = text;
      dbg.dataset.transcriptCount = String(Number(dbg.dataset.transcriptCount ?? 0) + 1);
      inputBar.setTranscript(text);
      inputBar.unlockField();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'OPEN_INPUT_BAR') {
      const { mode } = (message.payload ?? {}) as OpenInputBarPayload;
      inputBar.open(mode);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'DEBUG') {
      const { msg } = (message.payload ?? {}) as { msg: string };
      const log: string[] = JSON.parse(dbg.dataset.debugLog ?? '[]');
      log.push(`${new Date().toISOString().slice(11, 23)} ${msg}`);
      dbg.dataset.debugLog = JSON.stringify(log.slice(-30));
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'TASK_STARTED') {
      creature.setState('active');
      cursor.show();
    } else if (message.type === 'TASK_COMPLETE') {
      creature.setState('idle');
      cursor.hide();
    } else if (message.type === 'PAUSE_AT_STEP') {
      const { currentStep, totalSteps } = (message.payload ?? {}) as PauseAtStepPayload;
      console.log(`[SheetBuddy] Paused at step ${currentStep} of ${totalSteps}`);
      creature.setState('paused');
    } else if (message.type === 'CURSOR_MOVE_TO') {
      const { rect } = (message.payload ?? {}) as CursorMoveToPayload;
      if (rect) cursor.moveTo(rect);
    }

    console.log('[SheetBuddy] Content received:', message.type);
  },
);
