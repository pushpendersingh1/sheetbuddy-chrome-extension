import type { Message } from '../types/messages';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SheetBuddy] Extension installed');
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('devpanel.html') });
});

chrome.commands.onCommand.addListener((command) => {
  console.log('[SheetBuddy] Command received:', command);
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
): (r: unknown) => void {
  return (r) => sendResponse(r ?? { ok: false, error: 'No response from offscreen' });
}

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
          .then(relaySendResponse(sendResponse))
          .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      case 'START_RECORDING': {
        if (tabId !== null) activeTabId = tabId;
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ ...message, _relayed: true }))
          .then(relaySendResponse(sendResponse))
          .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      case 'TRANSCRIPT_PARTIAL':
      case 'TRANSCRIPT_FINAL': {
        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, message).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'NARRATION_DONE': {
        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, message).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: true });
    }
  },
);
