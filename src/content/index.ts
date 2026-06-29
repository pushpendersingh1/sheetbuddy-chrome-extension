import type { Message, RunPrimitivePayload } from '../types/messages';
import { handlePrimitive } from './router';
import { SheetBuddyCreature } from './creature';

console.log('[SheetBuddy] Content script loaded on', window.location.href);

const creature = new SheetBuddyCreature();
creature.mount();

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    if (message.type === 'RUN_PRIMITIVE') {
      const { name, args = [] } = (message.payload ?? {}) as RunPrimitivePayload;
      handlePrimitive(name, args).then(sendResponse);
      return true; // keep channel open for async response
    }

    if (message.type === 'TASK_STARTED') creature.setState('active');
    else if (message.type === 'TASK_COMPLETE') creature.setState('idle');
    else if (message.type === 'PAUSE_REQUESTED') creature.setState('paused');

    console.log('[SheetBuddy] Content received:', message.type);
  },
);
