import type { Message, UserQueryPayload } from '../types/messages';
import { makeDevReloader } from './dev-reload';
import { makeSheetPlanHandler } from './sheet-plan';
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

// Singleton promise prevents concurrent createDocument() calls (TOCTOU race).
let offscreenPromise: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
  offscreenPromise ??= chrome.offscreen.hasDocument().then(async (hasDoc) => {
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
  }).catch(err => {
    offscreenPromise = null;
    throw err;
  });
  return offscreenPromise;
}

function relaySendResponse(
  sendResponse: (r: unknown) => void,
  label: string,
): (r: unknown) => void {
  return (r) => {
    if (r == null) {
      console.error(`[SheetBuddy] No response from offscreen for ${label}`);
    }
    sendResponse(r ?? { ok: false, error: 'No response from offscreen' });
  };
}

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

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    const tabId = sender.tab?.id ?? null;
    console.log('[SheetBuddy] Background received:', message.type, 'from tab', tabId);

    switch (message.type) {
      case 'SPEAK':
      case 'STOP_NARRATION':
      case 'STOP_RECORDING': {
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ ...message, _relayed: true }))
          .then(relaySendResponse(sendResponse, message.type))
          .catch(err => {
            console.error(`[SheetBuddy] Relay failed for ${message.type}:`, err);
            sendResponse({ ok: false, error: String(err) });
          });
        return true;
      }

      case 'START_RECORDING': {
        if (tabId !== null) activeTabId = tabId;
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ ...message, _relayed: true }))
          .then(relaySendResponse(sendResponse, message.type))
          .catch(err => {
            console.error(`[SheetBuddy] Relay failed for ${message.type}:`, err);
            sendResponse({ ok: false, error: String(err) });
          });
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
          });
        }
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
