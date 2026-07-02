import type { Message, RelayedMessage, UserQueryPayload } from '../types/messages';
import type { Narrator } from '../offscreen/narrator';
import { makeDevReloader } from './dev-reload';
import { makeSheetPlanHandler } from './sheet-plan';
import { makeRelay } from './relay';
import { makeExecutionEngine } from './execution-engine';
import { makeSheetsApi } from './sheets-api';
import { makeUsageTracker } from '../usage';
import { WORKER_URL } from '../config';

// __DEV__ is true only in `npm run watch` (esbuild define).
// Unpacked extensions have no alarm minimum period, so 2 s is honoured in dev.
if (__DEV__) {
  const DEV_RELOAD_PERIOD_MINUTES = 1 / 30; // ~2 s
  const devCheckReload = makeDevReloader({
    fetchFn: globalThis.fetch.bind(globalThis),
    reload: () => chrome.runtime.reload(),
    url: 'http://127.0.0.1:35729/',
  });
  chrome.alarms.create('_dev_reload', { periodInMinutes: DEV_RELOAD_PERIOD_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === '_dev_reload') void devCheckReload();
  });
  void devCheckReload();
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SheetBuddy] Extension installed');
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('devpanel.html') });
});

chrome.commands.onCommand.addListener(async (command) => {
  console.log('[SheetBuddy] Command received:', command);

  const mode = command === 'push-to-talk' ? 'voice'
    : command === 'open-text-input' ? 'text'
    : null;

  if (!mode) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    console.warn('[SheetBuddy] No active tab found for command:', command);
    return;
  }

  chrome.tabs.sendMessage(tab.id, {
    type: 'OPEN_INPUT_BAR',
    payload: { mode },
  }).catch((err: unknown) => {
    console.warn('[SheetBuddy] Could not send OPEN_INPUT_BAR to tab:', err);
  });
});

let activeTabId: number | null = null;

const relayToOffscreen = makeRelay({
  ensureOffscreen: () =>
    chrome.offscreen.hasDocument().then(async (hasDoc) => {
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL('offscreen.html'),
          reasons: [
            chrome.offscreen.Reason.USER_MEDIA,
            chrome.offscreen.Reason.AUDIO_PLAYBACK,
          ],
          justification: 'Microphone capture and TTS audio playback for SheetBuddy',
        });
      }
    }),
  sendMessage: (message: RelayedMessage) => chrome.runtime.sendMessage(message),
});

async function compressScreenshot(dataUrl: string): Promise<string> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * 0.5),
    Math.round(bitmap.height * 0.5),
  );
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const compressed = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });

  // FileReader is not available in service workers; use ArrayBuffer + btoa instead.
  const buffer = await compressed.arrayBuffer();
  const uint8 = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(uint8.subarray(i, i + chunkSize)));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

const handleUserQuery = makeSheetPlanHandler({
  fetchFn: globalThis.fetch.bind(globalThis),
  captureVisibleTab: () => chrome.tabs.captureVisibleTab({ format: 'png' }).then(compressScreenshot),
  sendMessageToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  workerUrl: WORKER_URL,
});

// TTSNarrator (offscreen/narrator.ts) uses Audio/DOM and lives in the offscreen
// document — it can't be constructed directly in this service worker. Wrap the
// existing SPEAK relay into a Narrator instead.
function makeRelayedNarrator(relay: typeof relayToOffscreen): Narrator {
  return {
    speak(text: string): Promise<void> {
      return new Promise((resolve, reject) => {
        relay({ type: 'SPEAK', payload: { text } }, (response) => {
          const r = response as { ok: boolean; error?: string } | undefined;
          if (r?.ok) resolve();
          else reject(new Error(r?.error ?? 'SPEAK relay failed'));
        });
      });
    },
  };
}

const narrator = makeRelayedNarrator(relayToOffscreen);

// Graceful-degradation client (issue #23): when a DOM write primitive fails,
// the engine falls back to the Sheets REST API. Requires the manifest's oauth2
// client_id to be a real Google Cloud OAuth client — with the placeholder,
// getAuthToken rejects and the engine's "fallback also failed" path reports it.
const sheetsApi = makeSheetsApi({
  fetchFn: globalThis.fetch.bind(globalThis),
  getAuthToken: async (interactive) => {
    const { token } = await chrome.identity.getAuthToken({ interactive });
    if (!token) throw new Error('No OAuth token granted');
    return token;
  },
  removeCachedToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
});

// Mirrors the content script's tracker (src/content/index.ts) via the shared
// chrome.storage.local record: content gates, background increments.
const usage = makeUsageTracker({
  storageGet: (key) => chrome.storage.local.get(key),
  storageSet: (items) => chrome.storage.local.set(items),
});

const executionEngine = makeExecutionEngine({
  sendMessageToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  narrator,
  sheetsApi,
});

// For outcomes with no execution engine run (advisor/error) — TASK_STARTED
// never fires for these, so the cursor never lands on a cell, and
// content/index.ts's NARRATION_SHOW routing correctly puts the bubble on the
// creature throughout. Nothing else will ever clear it once speak() settles,
// so this explicitly hides it after (unlike plan mode, where the next step's
// NARRATION_SHOW or the final TASK_COMPLETE handles cleanup).
function speakStandaloneNarration(tabId: number, text: string, context: string): void {
  chrome.tabs.sendMessage(tabId, { type: 'NARRATION_SHOW', payload: { text } }).catch(() => {});
  narrator.speak(text)
    .catch((err: unknown) => {
      console.error(`[SheetBuddy] Narrator failed for ${context}:`, err);
    })
    .finally(() => {
      chrome.tabs.sendMessage(tabId, { type: 'NARRATION_HIDE' }).catch(() => {});
    });
}

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    const tabId = sender.tab?.id ?? null;
    console.log('[SheetBuddy] Background received:', message.type, 'from tab', tabId);

    switch (message.type) {
      case 'SPEAK':
      case 'STOP_NARRATION':
      case 'STOP_RECORDING': {
        relayToOffscreen(message, sendResponse);
        return true;
      }

      case 'START_RECORDING': {
        if (tabId !== null) activeTabId = tabId;
        relayToOffscreen(message, sendResponse);
        return true;
      }

      case 'USER_QUERY': {
        const { text } = (message.payload ?? {}) as UserQueryPayload;
        // Acknowledge immediately — the content script only needs to know the
        // message was received. Holding the channel open until the SheetPlan
        // pipeline finishes causes "message channel closed before response"
        // errors when the MV3 service worker is suspended mid-operation.
        sendResponse({ ok: true });
        if (tabId !== null) {
          void handleUserQuery(tabId, text).then(outcome => {
            console.log('[SheetBuddy] SheetPlan:', outcome);
            if (outcome.status === 'plan') {
              // Only real plan dispatches consume a free-tier interaction —
              // parse failures and advisor-only responses don't (issue #23).
              usage.increment().catch((err: unknown) => {
                console.error('[SheetBuddy] Failed to record usage:', err);
              });
              void executionEngine.execute(tabId, outcome).then(result => {
                console.log('[SheetBuddy] Execution finished:', result);
              }).catch((err: unknown) => {
                console.error('[SheetBuddy] Execution engine threw unexpectedly:', err);
              });
            } else if (outcome.status === 'advisor') {
              // Q&A responses ("what's in B3?") have no sheet actions to run and no
              // cell to point at — the only way the user ever hears (or sees) the
              // answer is speaking it here, bubble at the creature throughout.
              speakStandaloneNarration(tabId, outcome.plan.summary, 'advisor response');
            } else if (outcome.status === 'error') {
              // Same silent-drop problem as advisor, but for failures (context read
              // failed, worker error, network/timeout) — narrate so the user knows
              // *something* went wrong instead of the creature just going idle.
              speakStandaloneNarration(tabId, `Sorry, I ran into a problem: ${outcome.error}`, 'error response');
            }
          });
        } else {
          console.warn('[SheetBuddy] USER_QUERY received with no sender tab — dropping:', text);
        }
        break;
      }

      case 'PAUSE_REQUESTED': {
        executionEngine.requestPause();
        // Fire-and-forget: pause must register immediately regardless of whether
        // the offscreen doc actually has anything playing to stop.
        relayToOffscreen({ type: 'STOP_NARRATION' }, () => {});
        sendResponse({ ok: true });
        break;
      }

      case 'RESUME': {
        executionEngine.resume();
        sendResponse({ ok: true });
        break;
      }

      case 'ABORT': {
        executionEngine.abort();
        sendResponse({ ok: true });
        break;
      }

      case 'TRANSCRIPT_PARTIAL':
      case 'TRANSCRIPT_FINAL': {
        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, message).catch((err: unknown) => {
            console.warn('[SheetBuddy] Could not forward transcript to tab:', err);
          });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'NARRATION_DONE':
      case 'DEBUG': {
        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, message).catch((err: unknown) => {
            console.warn(`[SheetBuddy] Could not forward ${message.type} to tab:`, err);
          });
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        console.warn('[SheetBuddy] Background received unhandled message type:', message.type);
        sendResponse({ ok: true });
    }
  },
);
