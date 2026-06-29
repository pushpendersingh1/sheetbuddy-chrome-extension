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
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (const type of ['mouseover', 'mousedown', 'mouseup', 'click'] as const) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }),
    );
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
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
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: char }),
    );
    // <input>/<textarea>: setRangeText updates .value; contenteditable: execCommand
    if ((target as HTMLElement).matches('input, textarea')) {
      const inp = target as HTMLInputElement;
      const start = inp.selectionStart ?? inp.value.length;
      const end = inp.selectionEnd ?? inp.value.length;
      inp.setRangeText(char, start, end, 'end');
    } else {
      document.execCommand('insertText', false, char);
    }
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: char }),
    );
    dispatchKeyEvent(target, 'keyup', key, code);
  }
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
  // Only consider visible items — many same-text items exist in hidden toolbar menus
  const target = items.find((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return false;
    const label = el.querySelector('.goog-menuitem-label') ?? el;
    return ((label as HTMLElement).innerText ?? '').trim() === text;
  });
  if (!target) throw new Error(`Menu item "${text}" not found`);
  // Closure Library requires PointerEvents + MouseEvents with real coordinates
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const m: MouseEventInit = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: cx, clientY: cy };
  const p: PointerEventInit = { ...m, pointerType: 'mouse', isPrimary: true, pointerId: 1 };
  target.dispatchEvent(new PointerEvent('pointerover', p));
  target.dispatchEvent(new MouseEvent('mouseover', m));
  target.dispatchEvent(new PointerEvent('pointerdown', p));
  target.dispatchEvent(new MouseEvent('mousedown', m));
  target.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('mouseup', { ...m, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('click', m));
}

// Navigates a two-level menu: hovers the parent item to open its submenu,
// waits for it to render, then clicks the child.
// Use this for nested items like Format → Text → Bold.
// Prefer executeMenuItem() for anything reachable via the omnibox search.
async function clickSubMenuItem(parent: string, child: string): Promise<void> {
  clickMenuItem(parent);
  // Submenus render lazily after hover — 200 ms matches observed Sheets render time
  await new Promise<void>((r) => setTimeout(r, 200));
  clickMenuItem(child);
}

// Opens a top-level menu then walks the full path in one shot — no focus hand-off between steps.
// Use this instead of separate openMenu() + clickSubMenuItem() calls from the devpanel.
// Examples:
//   navigateMenu("Format", "Bold")          → Format → Bold (direct item)
//   navigateMenu("Format", "Text", "Bold")  → Format → Text → Bold (submenu)
async function navigateMenu(menuName: string, ...path: string[]): Promise<void> {
  openMenu(menuName);
  for (const item of path) {
    await new Promise<void>((r) => setTimeout(r, 200));
    clickMenuItem(item);
  }
}

async function executeMenuItem(text: string): Promise<void> {
  // .docs-omnibox-input is always in the DOM as a small icon; clicking it expands it.
  // Alt+/ keyboard dispatch does not expand it from an extension content script.
  const omnibox = document.querySelector<HTMLInputElement>('.docs-omnibox-input');
  if (!omnibox) throw new Error('.docs-omnibox-input not found — ensure the page is a Google Sheet');

  const rect = omnibox.getBoundingClientRect();
  const cx = rect.left + Math.min(10, rect.width / 2);
  const cy = rect.top + Math.min(10, rect.height / 2);
  omnibox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy }));
  omnibox.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy }));
  omnibox.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy }));
  omnibox.focus();

  // Wait for the omnibox to expand (from ~44px to ~350px)
  const expanded = await waitForCondition(() => omnibox.getBoundingClientRect().width >= 150, 2000);
  if (!expanded) throw new Error('Omnibox did not expand — ensure a cell is selected and not in edit mode');

  // Clear any existing value, then type the search text
  omnibox.value = '';
  omnibox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'deleteContentBackward', data: null }));
  typeIntoTextTarget(omnibox, text);

  await new Promise((r) => setTimeout(r, 400));

  omnibox.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  omnibox.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  omnibox.dispatchEvent(new KeyboardEvent('keyup',    { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
}

// Opens menuName, waits for items to render, captures full DOM info for every
// visible .goog-menuitem, then closes the menu — all in one executeScript call
// so focus never leaves Sheets. Returns one JSON string per item.
async function inspectMenu(menuName: string): Promise<string[]> {
  openMenu(menuName);
  await new Promise<void>((r) => setTimeout(r, 300));
  const results = Array.from(document.querySelectorAll('.goog-menuitem'))
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => {
      const label = el.querySelector('.goog-menuitem-label') ?? el;
      return JSON.stringify({
        innerText:   ((label as HTMLElement).innerText ?? '').trim(),
        textContent: (label.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ariaLabel:   el.getAttribute('aria-label') ?? '',
      });
    });
  // Close the menu so the sheet isn't left in an open-menu state
  const editor = document.getElementById('waffle-rich-text-editor') ?? document.body;
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  return results;
}

// ─── Public surface ──────────────────────────────────────────────────────────

(window as Window & { __sheetbuddy?: Record<string, unknown> }).__sheetbuddy = {
  openMenu,
  inspectMenu,
  clickMenuItem,
  clickSubMenuItem,
  navigateMenu,
  executeMenuItem,
};
