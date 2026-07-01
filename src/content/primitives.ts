// Isolated-world content script primitives.
// All DOM reads/writes here run in Chrome's isolated world — same DOM, separate JS env.

import type { CellRect, DOMContext } from '../types/messages';

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

// Google Sheets renders its grid on a single <canvas> — there is no per-cell DOM
// element to read a position from. The only real DOM signal for where a cell sits
// on screen is the selection-highlight overlay Sheets renders around whatever is
// currently selected: 4 border divs (top/right/bottom/left), present only once a
// selection has actually landed. Some border divs in the DOM pool are reused/hidden
// (zero-size) at any given time — filter those out before unioning.
function unionBorderRects(selector: string): CellRect | null {
  const rects = Array.from(document.querySelectorAll(selector))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return null;

  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// The SheetBuddy cursor's position source for single-cell steps (selectCell,
// navigateToSheet) — see unionBorderRects.
export function readActiveCellRect(): CellRect | null {
  return unionBorderRects('.range-border.active-cell-border');
}

// The SheetBuddy cursor's position source for range steps (selectRange) — the
// range's full bounding box, distinct from readActiveCellRect's single-cell rect.
export function readSelectionRect(): CellRect | null {
  return unionBorderRects('.range-border.selection-border');
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

export function readSheetGid(url = window.location.href): string {
  const u = new URL(url);
  return u.searchParams.get('gid') ?? new URLSearchParams(u.hash.slice(1)).get('gid') ?? '0';
}

export function selectCell(ref: string): void {
  // URL hash navigation: changes only the hash — no full page reload.
  // Verified: window.location.hash change triggers Sheets to select the given range.
  const gid = readSheetGid();
  window.location.hash = `gid=${gid}&range=${ref}`;
}

export async function selectRange(start: string, end: string): Promise<void> {
  selectCell(`${start}:${end}`);
}

const MAX_HEADER_COLUMNS = 50;
const HEADER_SCAN_SETTLE_TIMEOUT_MS = 2000;

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return false;
}

// Reads row 1 across columns, stopping at the first blank cell (standard header
// convention) or after MAX_HEADER_COLUMNS (runaway guard). Assumes the header row
// is row 1 — Google Sheets grid is canvas-rendered, so this is the only way to read
// values outside the currently-selected cell (a temporary measure until the Sheets
// API replaces DOM scanning). Each hop selects the header cell then polls the name
// box until Sheets' asynchronous selection catches up, since reading the formula
// bar immediately risks stale content from the previously selected cell. Restores
// the user's original selection when done.
export async function readColumnHeaders(): Promise<string[]> {
  const originalRef = readActiveCell();
  const headers: string[] = [];

  for (let i = 0; i < MAX_HEADER_COLUMNS; i++) {
    const ref = `${columnLetter(i)}1`;
    selectCell(ref);
    const settled = await waitForCondition(() => readActiveCell() === ref, HEADER_SCAN_SETTLE_TIMEOUT_MS);
    if (!settled) break;
    const value = readFormulaBar().trim();
    if (!value) break;
    headers.push(value);
  }

  if (originalRef) selectCell(originalRef);
  return headers;
}

// Bundles all DOMContext fields in one call so background needs a single
// RUN_PRIMITIVE round-trip instead of one per field. activeCell/formulaBar are
// read before readColumnHeaders() runs — it temporarily navigates away to scan
// row 1 and restores the original selection afterward, but doesn't wait for that
// restore to settle before resolving, so reading them after would risk a stale value.
export async function collectDOMContext(): Promise<DOMContext> {
  const activeCell = readActiveCell();
  const formulaBar = readFormulaBar();
  const columnHeaders = await readColumnHeaders();
  return {
    activeCell,
    formulaBar,
    spreadsheetId: readSpreadsheetId() ?? '',
    sheetGid: readSheetGid(),
    sheetName: activeSheetName(),
    columnHeaders,
    availableSheets: listSheets(),
  };
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

export function typeText(text: string, { overwrite = false }: { overwrite?: boolean } = {}): void {
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

  // F2 switches Sheets into formula-parse mode, which enables range highlighting
  // while a formula is being typed. Without it, text appears but cell references
  // are not coloured and range borders are not drawn.
  dispatchKeyEvent(editor, 'keydown', 'F2', 'F2', { keyCode: 113 });
  dispatchKeyEvent(editor, 'keyup', 'F2', 'F2', { keyCode: 113 });

  if (overwrite) {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      sel.deleteFromDocument();
    }
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
