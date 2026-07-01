import type { Message, RelayedMessage } from '../types/messages';

export interface RelayDeps {
  ensureOffscreen: () => Promise<void>;
  sendMessage: (message: RelayedMessage) => Promise<unknown>;
}

// Owns everything needed to safely deliver a message to the offscreen document:
// making sure it exists, stamping it so offscreen can tell a deliberate relay
// apart from chrome.runtime.sendMessage's broadcast-to-everyone semantics, and
// reporting a missing/failed response back through sendResponse rather than
// leaving the caller's message channel hanging open. Deps are injected so this
// is unit-testable without Chrome APIs, mirroring sheet-plan.ts/dev-reload.ts.
export function makeRelay(deps: RelayDeps) {
  const { ensureOffscreen, sendMessage } = deps;

  // Closure-scoped (not module-scope) so each makeRelay(...) instance — e.g.
  // each test — gets its own independent singleton instead of sharing state.
  let offscreenPromise: Promise<void> | null = null;

  function ensureOffscreenOnce(): Promise<void> {
    offscreenPromise ??= ensureOffscreen().catch(err => {
      offscreenPromise = null;
      throw err;
    });
    return offscreenPromise;
  }

  return function relayToOffscreen(message: Message, sendResponse: (r: unknown) => void): void {
    ensureOffscreenOnce()
      .then(() => sendMessage({ ...message, _relayed: true }))
      .then(response => {
        if (response == null) {
          console.error(`[SheetBuddy] No response from offscreen for ${message.type}`);
        }
        sendResponse(response ?? { ok: false, error: 'No response from offscreen' });
      })
      .catch(err => {
        console.error(`[SheetBuddy] Relay failed for ${message.type}:`, err);
        sendResponse({ ok: false, error: String(err) });
      });
  };
}
