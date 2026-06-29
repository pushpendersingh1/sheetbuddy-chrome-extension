// Isolated-world content script primitives.
// All DOM reads/writes here run in Chrome's isolated world — same DOM, separate JS env.

export type OS = 'mac' | 'pc' | 'chromeos';

export interface ShortcutDef {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

// ─── OS detection ────────────────────────────────────────────────────────────

export function detectOS(): OS {
  const ua = navigator.userAgent;
  if (ua.includes('CrOS')) return 'chromeos';
  if (ua.includes('Mac')) return 'mac';
  return 'pc';
}

// ─── Spreadsheet ID ──────────────────────────────────────────────────────────

export function readSpreadsheetId(url = window.location.href): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

// ─── Safe keyboard target ────────────────────────────────────────────────────

// Never dispatch to window/document — always use this to resolve the target.
export function safeKeyTarget(): Element {
  const active = document.activeElement;
  if (active && active.nodeType === Node.ELEMENT_NODE && active !== document.body) {
    return active;
  }
  return (
    document.getElementById('waffle-rich-text-editor') ??
    document.body
  );
}

// ─── Internal key dispatch helpers ───────────────────────────────────────────

function dispatchKeyEvent(
  target: Element,
  type: 'keydown' | 'keypress' | 'keyup',
  key: string,
  code: string,
  init: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    }),
  );
}

function dispatchKey(
  target: Element,
  key: string,
  code: string,
  init: KeyboardEventInit = {},
): void {
  dispatchKeyEvent(target, 'keydown', key, code, init);
  dispatchKeyEvent(target, 'keypress', key, code, init);
  dispatchKeyEvent(target, 'keyup', key, code, init);
}

function getKeyInfo(char: string): { key: string; code: string } {
  if (/^[a-zA-Z]$/.test(char)) return { key: char, code: `Key${char.toUpperCase()}` };
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}` };
  const map: Record<string, { key: string; code: string }> = {
    '=': { key: '=', code: 'Equal' },
    '+': { key: '+', code: 'Equal' },
    '(': { key: '(', code: 'Digit9' },
    ')': { key: ')', code: 'Digit0' },
    ',': { key: ',', code: 'Comma' },
    '.': { key: '.', code: 'Period' },
    ':': { key: ':', code: 'Semicolon' },
    ' ': { key: ' ', code: 'Space' },
    '-': { key: '-', code: 'Minus' },
    '*': { key: '*', code: 'Digit8' },
    '/': { key: '/', code: 'Slash' },
    '_': { key: '_', code: 'Minus' },
    '\n': { key: 'Enter', code: 'Enter' },
  };
  return map[char] ?? { key: char, code: 'Unknown' };
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

// ─── Read primitives ─────────────────────────────────────────────────────────

export function readFormulaBar(): string {
  const el = document.querySelector(
    '#t-formula-bar-input-container .cell-input',
  );
  return el?.textContent?.trim() ?? '';
}

export function readActiveCell(): string {
  // Name Box is an <input id="t-name-box"> — read .value, not textContent
  const el = document.querySelector<HTMLInputElement>('#t-name-box');
  return el?.value?.trim() ?? '';
}

export function readCellError(): string {
  const el = document.querySelector<HTMLElement>('.annotation-attribution-error');
  if (!el) return '';
  const span = el.querySelector('span');
  return span?.textContent?.trim() ?? el.textContent?.trim() ?? '';
}

export function listSheets(): string[] {
  // .docs-sheet-tab-name is the visible label span inside each tab;
  // the outer .docs-sheet-tab textContent includes hidden SVG text ("0" comment count)
  return Array.from(document.querySelectorAll('.docs-sheet-tab .docs-sheet-tab-name')).map(
    (el) => el.textContent?.trim() ?? '',
  );
}

export function activeSheetName(): string {
  const el = document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name');
  return el?.textContent?.trim() ?? '';
}

// ─── Navigation primitives ───────────────────────────────────────────────────

export function selectCell(ref: string): void {
  // URL hash navigation: changes only the hash — no full page reload.
  // Verified: window.location.hash change triggers Sheets to select the given range.
  const url = new URL(window.location.href);
  const gid =
    url.searchParams.get('gid') ??
    new URLSearchParams(window.location.hash.slice(1)).get('gid') ??
    '0';
  window.location.hash = `gid=${gid}&range=${ref}`;
}

export async function selectRange(start: string, end: string): Promise<void> {
  selectCell(`${start}:${end}`);
}

export function navigateToSheet(name: string): void {
  // Match by the visible label span, then click the parent tab element
  const labelEls = Array.from(document.querySelectorAll('.docs-sheet-tab .docs-sheet-tab-name'));
  const labelEl = labelEls.find((el) => el.textContent?.trim() === name);
  if (!labelEl) throw new Error(`Sheet tab "${name}" not found`);
  const tabEl = labelEl.closest('.docs-sheet-tab') as Element;
  simulateMouseClick(tabEl);
}

// ─── Edit primitives ─────────────────────────────────────────────────────────

export function enterEditMode(): void {
  // F2 enters edit mode on the selected cell. Enter moves the cursor down — not edit mode.
  const editor =
    document.getElementById('waffle-rich-text-editor') ?? (safeKeyTarget() as HTMLElement);
  (editor as HTMLElement).focus?.();
  dispatchKeyEvent(editor, 'keydown', 'F2', 'F2', { keyCode: 113 });
  dispatchKeyEvent(editor, 'keyup', 'F2', 'F2', { keyCode: 113 });
}

export function typeText(text: string): void {
  const editor = document.getElementById('waffle-rich-text-editor');
  if (!editor) throw new Error('Editor (#waffle-rich-text-editor) not found — call enterEditMode() first');

  // Focus guard: if something else has focus (user clicked away), abort rather than corrupt their work.
  const active = document.activeElement;
  if (active !== editor) {
    if (active && active !== document.body && active.nodeType === Node.ELEMENT_NODE) {
      throw new Error('typeText aborted: focus is held by another element — user may have clicked away');
    }
    editor.focus();
  }

  for (const char of text) {
    const { key, code } = getKeyInfo(char);
    dispatchKeyEvent(editor, 'keydown', key, code);
    dispatchKeyEvent(editor, 'keypress', key, code);
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: char,
      }),
    );
    document.execCommand('insertText', false, char);
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: char,
      }),
    );
    dispatchKeyEvent(editor, 'keyup', key, code);
  }
}

export function commitCell(): void {
  const editor = document.getElementById('waffle-rich-text-editor') as HTMLElement | null;
  const target = editor ?? safeKeyTarget();
  (target as HTMLElement).focus?.();
  dispatchKey(target, 'Enter', 'Enter', { keyCode: 13, which: 13 });
}

// Replaces the entire cell content via the formula bar — no streaming, no append.
// Use this for formula writes (e.g. "=SUM(A1:A10)"). Use typeText() for char-by-char streaming.
export async function writeToSelectedCell(text: string): Promise<void> {
  const formulaBar = document.querySelector<HTMLElement>(
    '#t-formula-bar-input > div.cell-input',
  );
  if (!formulaBar) throw new Error('Formula bar cell-input not found');

  formulaBar.focus();
  await new Promise<void>((r) => setTimeout(r, 1));

  // Clear all existing content using Selection API (matches Shortiecuts approach)
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(formulaBar);
    sel.removeAllRanges();
    sel.addRange(range);
    sel.deleteFromDocument();
    // After deletion, selection is collapsed inside the now-empty formulaBar
    const sel2 = window.getSelection();
    if (sel2 && sel2.rangeCount > 0) {
      sel2.getRangeAt(0).insertNode(document.createTextNode(text));
      sel2.collapseToEnd();
    }
  }

  await new Promise<void>((r) => setTimeout(r, 1));

  // Commit — keyCode required by Sheets (same as commitCell fix)
  dispatchKey(formulaBar, 'Enter', 'Enter', { keyCode: 13, which: 13 });
}

export function pressEscape(): void {
  const editor = document.getElementById('waffle-rich-text-editor') as HTMLElement | null;
  const target = editor ?? safeKeyTarget();
  (target as HTMLElement).focus?.();
  dispatchKey(target, 'Escape', 'Escape', { keyCode: 27, which: 27 });
}

// ─── Shortcut primitives ─────────────────────────────────────────────────────

const SHORTCUT_MAP: Record<string, Record<OS, ShortcutDef>> = {
  bold: {
    mac:      { key: 'b', code: 'KeyB', metaKey: true },
    pc:       { key: 'b', code: 'KeyB', ctrlKey: true },
    chromeos: { key: 'b', code: 'KeyB', ctrlKey: true },
  },
  italic: {
    mac:      { key: 'i', code: 'KeyI', metaKey: true },
    pc:       { key: 'i', code: 'KeyI', ctrlKey: true },
    chromeos: { key: 'i', code: 'KeyI', ctrlKey: true },
  },
  underline: {
    mac:      { key: 'u', code: 'KeyU', metaKey: true },
    pc:       { key: 'u', code: 'KeyU', ctrlKey: true },
    chromeos: { key: 'u', code: 'KeyU', ctrlKey: true },
  },
  undo: {
    mac:      { key: 'z', code: 'KeyZ', metaKey: true },
    pc:       { key: 'z', code: 'KeyZ', ctrlKey: true },
    chromeos: { key: 'z', code: 'KeyZ', ctrlKey: true },
  },
  redo: {
    mac:      { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true },
    pc:       { key: 'y', code: 'KeyY', ctrlKey: true },
    chromeos: { key: 'y', code: 'KeyY', ctrlKey: true },
  },
};

export function getShortcutDef(id: string, os: OS): ShortcutDef {
  const defs = SHORTCUT_MAP[id];
  if (!defs) throw new Error(`Unknown shortcut: "${id}"`);
  return defs[os];
}

export function dispatchShortcut(id: string): void {
  const os = detectOS();
  const def = getShortcutDef(id, os);
  const target = safeKeyTarget();
  dispatchKey(target, def.key, def.code, {
    ctrlKey: def.ctrlKey,
    metaKey: def.metaKey,
    shiftKey: def.shiftKey,
    altKey: def.altKey,
  });
}
