import type { Message, RunPrimitivePayload } from '../types/messages';
import { handlePrimitive } from './router';

console.log('[SheetBuddy] Content script loaded on', window.location.href);

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    if (message.type === 'RUN_PRIMITIVE') {
      const { name, args = [] } = (message.payload ?? {}) as RunPrimitivePayload;
      handlePrimitive(name, args).then(sendResponse);
      return true; // keep channel open for async response
    }
    console.log('[SheetBuddy] Content received:', message.type);
  },
);
