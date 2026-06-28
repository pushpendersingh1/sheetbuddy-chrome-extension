import type { Message } from '../types/messages';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SheetBuddy] Extension installed');
});

chrome.commands.onCommand.addListener((command) => {
  console.log('[SheetBuddy] Command received:', command);
});

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    console.log('[SheetBuddy] Background received:', message.type, 'from tab', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  },
);
