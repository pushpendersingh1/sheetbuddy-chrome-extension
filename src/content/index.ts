import type { Message } from '../types/messages';

console.log('[SheetBuddy] Content script loaded on', window.location.href);

chrome.runtime.onMessage.addListener((message: Message) => {
  console.log('[SheetBuddy] Content received:', message.type);
});
