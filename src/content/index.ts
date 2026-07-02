import type { Message, RunPrimitivePayload, TranscriptPayload, OpenInputBarPayload, UserQueryPayload, PauseAtStepPayload, CursorMoveToPayload, NarrationShowPayload } from '../types/messages';
import { handlePrimitive } from './router';
import { SheetBuddyCreature } from './creature';
import { SheetBuddyCursor } from './cursor';
import { InputBar } from './input-bar';
import { makeChromeUsageTracker, DAILY_FREE_LIMIT } from '../usage';

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

// The cursor's "home" position — where it rests before any cell is confirmed
// this run, and where its first flight visibly originates from.
function creatureCenterPoint(): { x: number; y: number } {
  const rect = creatureHost?.getBoundingClientRect();
  if (!rect) return { x: window.innerWidth, y: window.innerHeight };
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

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

// Free-tier gate (issue #23): shared with background via chrome.storage.local —
// this side only checks; background increments on successful plan outcomes.
const usage = makeChromeUsageTracker();

const LIMIT_MESSAGE = `You've used all ${DAILY_FREE_LIMIT} free interactions today — upgrade for unlimited access`;

inputBar.onOpen = () => {
  usage.remaining()
    .then((n) => inputBar.setRemaining(n))
    .catch(() => {}); // count display is best-effort — never block the bar on it
};

inputBar.onQuery = (text: string) => {
  void (async () => {
    // Fail-open: a storage read error must not lock a paying-attention user out.
    const remaining = await usage.remaining().catch(() => 1);
    if (remaining <= 0) {
      creature.showBubble(LIMIT_MESSAGE);
      // SPEAK resolves when playback ends — keep the bubble up until then. No
      // TASK_COMPLETE will ever fire here (nothing was dispatched), so the
      // bubble must be hidden explicitly.
      await chrome.runtime.sendMessage({ type: 'SPEAK', payload: { text: LIMIT_MESSAGE } }).catch(() => {});
      creature.hideBubble();
      return;
    }

    creature.setState('thinking');
    chrome.runtime.sendMessage({ type: 'USER_QUERY', payload: { text } satisfies UserQueryPayload }).catch(
      (err: unknown) => {
        console.error('[SheetBuddy] Failed to send USER_QUERY:', err);
        creature.setState('idle');
      },
    );
  })();
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
      // Snap to the creature's position now, before any cell is confirmed —
      // the first real moveTo() this run then visibly flies from here.
      cursor.showAtHome(creatureCenterPoint());
    } else if (message.type === 'TASK_COMPLETE') {
      creature.setState('idle');
      cursor.hide();
      creature.hideBubble();
    } else if (message.type === 'PAUSE_AT_STEP') {
      const { currentStep, totalSteps } = (message.payload ?? {}) as PauseAtStepPayload;
      console.log(`[SheetBuddy] Paused at step ${currentStep} of ${totalSteps}`);
      creature.setState('paused');
    } else if (message.type === 'CURSOR_MOVE_TO') {
      const { rect } = (message.payload ?? {}) as CursorMoveToPayload;
      if (rect) cursor.moveTo(rect);
    } else if (message.type === 'NARRATION_SHOW') {
      const { text } = (message.payload ?? {}) as NarrationShowPayload;
      // Before the cursor has landed on a cell this run (or for advisor/error
      // responses that never point at anything), narration shows at the
      // creature instead of floating with an unlanded cursor.
      if (cursor.hasLandedOnCell()) cursor.showLabel(text);
      else creature.showBubble(text);
    } else if (message.type === 'NARRATION_HIDE') {
      cursor.hideLabel();
      creature.hideBubble();
    }

    console.log('[SheetBuddy] Content received:', message.type);
  },
);
