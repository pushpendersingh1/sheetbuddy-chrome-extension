// Runs in MAIN world — injected via manifest content_scripts with "world": "MAIN".
// Has access to the page's full JS context (goog.*, Closure Library, etc.).
// Functions are exposed on window.__sheetbuddy so devpanel can call them via
// chrome.scripting.executeScript({ world: 'MAIN', func: ... }).

console.log('[SheetBuddy] MAIN-world script injected');

// ─── Internal helpers (duplicated from primitives.ts — separate JS worlds) ───

function safeKeyTarget(): Element {
  const active = document.activeElement;
  if (active && active.nodeType === Node.ELEMENT_NODE && active !== document.body) {
    return active;
  }
  return document.getElementById('waffle-rich-text-editor') ?? document.body;
}

function dispatchKeyEvent(
  target: Element,
  type: 'keydown' | 'keypress' | 'keyup',
  key: string,
  code: string,
  init: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true, ...init }),
  );
}

function dispatchKey(target: Element, key: string, code: string, init: KeyboardEventInit = {}): void {
  dispatchKeyEvent(target, 'keydown', key, code, init);
  dispatchKeyEvent(target, 'keypress', key, code, init);
  dispatchKeyEvent(target, 'keyup', key, code, init);
}

function simulateMouseClick(el: Element): void {
  for (const type of ['mouseover', 'mousedown', 'mouseup', 'click'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

async function waitForNewTextInput(
  existingInputs: Set<HTMLInputElement>,
  timeoutMs: number,
): Promise<HTMLInputElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'),
    );
    // Only accept an input that was not visible before Alt+/ was dispatched
    const newInput = inputs.find(
      (el) => !existingInputs.has(el) && el.offsetParent !== null,
    );
    if (newInput) return newInput;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function typeIntoTextTarget(target: HTMLElement, text: string): void {
  target.focus();
  for (const char of text) {
    const upper = char.toUpperCase();
    const key = char;
    const code = /^[a-zA-Z]$/.test(char) ? `Key${upper}` : char.length === 1 ? 'Unknown' : char;
    dispatchKeyEvent(target, 'keydown', key, code);
    dispatchKeyEvent(target, 'keypress', key, code);
    target.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }),
    );
    document.execCommand('insertText', false, char);
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }),
    );
    dispatchKeyEvent(target, 'keyup', key, code);
  }
}

function pressEnterOnTarget(target: HTMLElement): void {
  dispatchKey(target, 'Enter', 'Enter');
}

// ─── MAIN-world menu primitives ──────────────────────────────────────────────

function openMenu(name: string): void {
  // Try known IDs first, then aria-label, then text content search
  const byId: Record<string, string> = {
    File: 'docs-file-menu',
    Edit: 'docs-edit-menu',
    View: 'docs-view-menu',
    Insert: 'docs-insert-menu',
    Format: 'docs-format-menu',
    Data: 'docs-data-menu',
    Tools: 'docs-tools-menu',
    Extensions: 'docs-extensions-menu',
    Help: 'docs-help-menu',
  };

  let menuEl: Element | null = null;

  if (byId[name]) {
    menuEl = document.getElementById(byId[name]);
  }

  if (!menuEl) {
    menuEl = document.querySelector(`[aria-label="${name}"]`);
  }

  if (!menuEl) {
    // Text content fallback — look for menu buttons containing the label
    const candidates = Array.from(
      document.querySelectorAll('.menu-button, [role="menubar"] > [role="menuitem"], .goog-menu-button'),
    );
    menuEl = candidates.find((el) => el.textContent?.trim() === name) ?? null;
  }

  if (!menuEl) throw new Error(`Menu "${name}" not found`);
  simulateMouseClick(menuEl);
}

function clickMenuItem(text: string): void {
  const items = Array.from(document.querySelectorAll('.goog-menuitem'));
  const target = items.find((el) => {
    const label = el.querySelector('.goog-menuitem-label') ?? el;
    return label.textContent?.trim() === text;
  });
  if (!target) throw new Error(`Menu item "${text}" not found`);
  // Closure Library menu items respond to .click() on the inner content div,
  // not to synthetic mouseover/mousedown/mouseup/click sequences on the outer element.
  const content = target.querySelector('.goog-menuitem-content') ?? target;
  (content as HTMLElement).click();
}

async function executeMenuItem(text: string): Promise<void> {
  const keyTarget = safeKeyTarget();

  // Snapshot all currently-visible text inputs BEFORE triggering Alt+/,
  // so waitForNewTextInput can detect the search popup as a genuinely new element.
  const existingInputs = new Set(
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'))
      .filter((el) => el.offsetParent !== null),
  );

  // Alt+/ opens the "Search menu items" bar in Google Sheets
  dispatchKeyEvent(keyTarget, 'keydown', '/', 'Slash', { altKey: true });
  dispatchKeyEvent(keyTarget, 'keypress', '/', 'Slash', { altKey: true });
  dispatchKeyEvent(keyTarget, 'keyup', '/', 'Slash', { altKey: true });

  const searchInput = await waitForNewTextInput(existingInputs, 2000);
  if (!searchInput) throw new Error('Alt+/ search box did not appear within 2s');

  typeIntoTextTarget(searchInput, text);
  pressEnterOnTarget(searchInput);
}

// ─── Public surface ──────────────────────────────────────────────────────────

(window as Window & { __sheetbuddy?: Record<string, unknown> }).__sheetbuddy = {
  openMenu,
  clickMenuItem,
  executeMenuItem,
};
