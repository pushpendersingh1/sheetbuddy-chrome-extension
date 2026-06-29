import type { Message, SpeakPayload, TranscriptPayload } from '../types/messages';
import { WORKER_URL } from '../config';
import { TTSNarrator } from './narrator';
import { Transcriber } from './transcriber';

console.log('[SheetBuddy] Offscreen document ready');

const narrator = new TTSNarrator(WORKER_URL);
let transcriber: Transcriber | null = null;

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  switch (message.type) {
    case 'SPEAK': {
      const { text } = (message.payload ?? {}) as SpeakPayload;
      if (!text) {
        sendResponse({ ok: false, error: 'Missing text payload' });
        break;
      }
      narrator.speak(text)
        .then(() => {
          chrome.runtime.sendMessage({ type: 'NARRATION_DONE' });
          sendResponse({ ok: true });
        })
        .catch((err: unknown) => {
          console.error('[SheetBuddy] TTS error:', err);
          sendResponse({ ok: false, error: String(err) });
        });
      return true;
    }

    case 'STOP_NARRATION': {
      // narrator.stop() deferred to issue #21 — no audio ref stored on TTSNarrator yet
      sendResponse({ ok: true });
      break;
    }

    case 'START_RECORDING': {
      if (transcriber) {
        sendResponse({ ok: false, error: 'Already recording' });
        break;
      }
      transcriber = new Transcriber(WORKER_URL, (text, isFinal) => {
        const payload: TranscriptPayload = { text, isFinal };
        chrome.runtime.sendMessage({
          type: isFinal ? 'TRANSCRIPT_FINAL' : 'TRANSCRIPT_PARTIAL',
          payload,
        });
      });
      transcriber.start()
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => {
          console.error('[SheetBuddy] Recording start error:', err);
          transcriber = null;
          sendResponse({ ok: false, error: String(err) });
        });
      return true;
    }

    case 'STOP_RECORDING': {
      transcriber?.stop();
      transcriber = null;
      sendResponse({ ok: true });
      break;
    }

    default:
      console.log('[SheetBuddy] Offscreen received unhandled:', message.type);
      sendResponse({ ok: false, error: `Unhandled message type: ${message.type}` });
  }
});
