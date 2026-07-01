import type { Message, RunPrimitivePayload, TranscriptPayload, OpenInputBarPayload, UserQueryPayload } from '../types/messages';
import { handlePrimitive } from './router';
import { SheetBuddyCreature } from './creature';
import { InputBar } from './input-bar';

console.log('[SheetBuddy] Content script loaded on', window.location.href);

const creature = new SheetBuddyCreature();
creature.mount();

const inputBar = new InputBar();
inputBar.mount();

// Wire creature click → open bar in 'both' mode (voice button + text field, nothing auto-started)
creature.onClick = () => inputBar.open('both');

// Wire input bar callbacks → chrome messaging + creature state
inputBar.onStartRecording = () => {
  creature.setState('listening');
  chrome.runtime.sendMessage({ type: 'START_RECORDING' }).catch((err: unknown) => {
    console.error('[SheetBuddy] Failed to send START_RECORDING:', err);
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
      inputBar.setTranscript(text);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'TRANSCRIPT_FINAL') {
      const { text } = (message.payload ?? {}) as TranscriptPayload;
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

    if (message.type === 'TASK_STARTED') creature.setState('active');
    else if (message.type === 'TASK_COMPLETE') creature.setState('idle');
    else if (message.type === 'PAUSE_REQUESTED') creature.setState('paused');

    console.log('[SheetBuddy] Content received:', message.type);
  },
);
