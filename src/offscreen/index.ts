import type { Message, SpeakPayload } from '../types/messages';
import { WORKER_URL } from '../config';
import { TTSNarrator } from './narrator';
import { Transcriber } from './transcriber';
import { AssemblyAIAdapter } from './assemblyai-adapter';
import { makeTranscriptPipeline } from './pipeline';

console.log('[SheetBuddy] Offscreen document ready');

const narrator = new TTSNarrator(WORKER_URL);

const transcriptPipeline = makeTranscriptPipeline({
  createTranscriber: (onTranscript, onDebug) => new Transcriber(new AssemblyAIAdapter(WORKER_URL), onTranscript, onDebug),
  sendMessage: (message) => chrome.runtime.sendMessage(message),
});

chrome.runtime.onMessage.addListener((message: Message & { _relayed?: boolean }, _sender, sendResponse) => {
  // chrome.runtime.sendMessage broadcasts to ALL extension contexts.
  // Ignore messages not explicitly relayed by the background to avoid double-processing.
  if (!message._relayed) {
    console.log('[SheetBuddy] Offscreen ignored direct broadcast (not relayed):', message.type);
    return;
  }
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
      narrator.stop();
      sendResponse({ ok: true });
      break;
    }

    case 'START_RECORDING': {
      transcriptPipeline.startRecording().then(sendResponse);
      return true;
    }

    case 'STOP_RECORDING': {
      transcriptPipeline.stopRecording();
      sendResponse({ ok: true });
      break;
    }

    default:
      console.log('[SheetBuddy] Offscreen received unhandled:', message.type);
      sendResponse({ ok: false, error: `Unhandled message type: ${message.type}` });
  }
});
