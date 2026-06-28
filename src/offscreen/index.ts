import type { Message } from '../types/messages';

console.log('[SheetBuddy] Offscreen document ready');

chrome.runtime.onMessage.addListener((message: Message) => {
  console.log('[SheetBuddy] Offscreen received:', message.type);
});
