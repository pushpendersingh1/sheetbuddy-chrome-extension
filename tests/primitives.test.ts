import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectOS,
  readSpreadsheetId,
  safeKeyTarget,
  readFormulaBar,
  readActiveCell,
  readSheetGid,
  readColumnHeaders,
  collectDOMContext,
  listSheets,
  activeSheetName,
  getShortcutDef,
  typeText,
  writeToSelectedCell,
  selectCell,
} from '../src/content/primitives';

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

// --- detectOS ---

describe('detectOS', () => {
  it('returns mac for Mac user agent', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    expect(detectOS()).toBe('mac');
  });

  it('returns chromeos for CrOS user agent', () => {
    setUserAgent('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36');
    expect(detectOS()).toBe('chromeos');
  });

  it('returns pc for Windows user agent', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    expect(detectOS()).toBe('pc');
  });
});

// --- readSpreadsheetId ---

describe('readSpreadsheetId', () => {
  it('extracts spreadsheet ID from a Google Sheets URL', () => {
    expect(
      readSpreadsheetId(
        'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit#gid=0',
      ),
    ).toBe('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms');
  });

  it('returns null for non-spreadsheet URL', () => {
    expect(readSpreadsheetId('https://www.google.com')).toBeNull();
  });

  it('handles URL with gid query param', () => {
    expect(
      readSpreadsheetId(
        'https://docs.google.com/spreadsheets/d/abc123XYZ/edit?gid=0#gid=0',
      ),
    ).toBe('abc123XYZ');
  });
});

// --- readSheetGid ---

describe('readSheetGid', () => {
  it('extracts gid from a query param', () => {
    expect(readSheetGid('https://docs.google.com/spreadsheets/d/abc/edit?gid=42')).toBe('42');
  });

  it('extracts gid from the hash when no query param is present', () => {
    expect(readSheetGid('https://docs.google.com/spreadsheets/d/abc/edit#gid=99&range=A1')).toBe('99');
  });

  it('prefers the query param over the hash when both are present', () => {
    expect(
      readSheetGid('https://docs.google.com/spreadsheets/d/abc/edit?gid=42#gid=99'),
    ).toBe('42');
  });

  it('defaults to "0" when neither query param nor hash gid is present', () => {
    expect(readSheetGid('https://docs.google.com/spreadsheets/d/abc/edit')).toBe('0');
  });
});

// --- selectCell ---

describe('selectCell', () => {
  it('navigates using the gid read from the current URL', () => {
    window.history.replaceState(null, '', '/spreadsheets/d/abc/edit?gid=7');
    selectCell('B7');
    expect(window.location.hash).toBe('#gid=7&range=B7');
  });

  it('defaults to gid=0 when the current URL has no gid', () => {
    window.history.replaceState(null, '', '/spreadsheets/d/abc/edit');
    selectCell('A1');
    expect(window.location.hash).toBe('#gid=0&range=A1');
  });
});

// --- readColumnHeaders / collectDOMContext shared helpers ---

// Column-letter generation mirroring the primitive's own (A, B, ... Z, AA, AB, ...)
// so tests can build a headers fixture beyond 26 columns without hard-coding it.
function colLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function setNameBox(value: string) {
  (document.getElementById('t-name-box') as HTMLInputElement).value = value;
}

function setFormulaBar(value: string) {
  document.querySelector('#t-formula-bar-input-container .cell-input')!.textContent = value;
}

// Simulates Sheets asynchronously catching up to a hash-driven selection change:
// polls location.hash (avoids relying on jsdom's hashchange event support) and,
// after `delayMs`, updates the name box + formula bar to reflect the new range.
// `skip` lets a specific ref simulate a stuck/unresponsive Sheets UI.
function simulateSheetsResponding(
  headers: Record<string, string>,
  { delayMs = 10, skip = new Set<string>() }: { delayMs?: number; skip?: Set<string> } = {},
) {
  let lastHash = window.location.hash;
  setInterval(() => {
    if (window.location.hash === lastHash) return;
    lastHash = window.location.hash;
    const range = new URLSearchParams(lastHash.slice(1)).get('range') ?? '';
    if (skip.has(range)) return;
    setTimeout(() => {
      setNameBox(range);
      setFormulaBar(headers[range] ?? '');
    }, delayMs);
  }, 5);
}

describe('readColumnHeaders', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="t-name-box" value="" />
      <div id="t-formula-bar-input-container"><div class="cell-input"></div></div>
    `;
    window.history.replaceState(null, '', '/spreadsheets/d/abc/edit?gid=0');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans columns left to right and stops at the first blank cell', async () => {
    simulateSheetsResponding({ A1: 'Name', B1: 'Sales', C1: '' });
    setNameBox('D10');

    const resultPromise = readColumnHeaders();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await resultPromise).toEqual(['Name', 'Sales']);
  });

  it('returns an empty array when the header row is already blank', async () => {
    simulateSheetsResponding({ A1: '' });
    setNameBox('D10');

    const resultPromise = readColumnHeaders();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await resultPromise).toEqual([]);
  });

  it('restores the original active cell once scanning finishes', async () => {
    simulateSheetsResponding({ A1: 'Name', B1: '' });
    setNameBox('D10');

    const resultPromise = readColumnHeaders();
    await vi.advanceTimersByTimeAsync(2000);
    await resultPromise;

    expect(window.location.hash).toBe('#gid=0&range=D10');
  });

  it('caps scanning at 50 columns when no blank cell is ever found', async () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 60; i++) headers[`${colLetter(i)}1`] = `H${i}`;
    simulateSheetsResponding(headers);
    setNameBox('D10');

    const resultPromise = readColumnHeaders();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await resultPromise).length).toBe(50);
  });

  it('waits for the name box to settle before trusting the formula bar reading', async () => {
    // A slow (but eventually responding) Sheets — proves the read isn't taken
    // before the selection actually catches up to B1.
    simulateSheetsResponding({ A1: 'Name', B1: 'Sales', C1: '' }, { delayMs: 500 });
    setNameBox('D10');

    const resultPromise = readColumnHeaders();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await resultPromise).toEqual(['Name', 'Sales']);
  });

  it('gives up scanning a column that never settles, keeping headers already found', async () => {
    simulateSheetsResponding({ A1: 'Name', B1: 'Sales' }, { skip: new Set(['C1']) });
    setNameBox('D10');

    const resultPromise = readColumnHeaders();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await resultPromise).toEqual(['Name', 'Sales']);
  });
});

// --- collectDOMContext ---

describe('collectDOMContext', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="t-name-box" value="D10" />
      <div id="t-formula-bar-input-container"><div class="cell-input">=SUM(A1:A10)</div></div>
      <div class="docs-sheet-tab docs-sheet-active-tab"><span class="docs-sheet-tab-name">Sheet1</span></div>
      <div class="docs-sheet-tab"><span class="docs-sheet-tab-name">Sheet2</span></div>
    `;
    window.history.replaceState(
      null, '',
      '/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit?gid=7',
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bundles all DOMContext fields, keeping activeCell/formulaBar from the original selection (not the header scan)', async () => {
    simulateSheetsResponding({ A1: 'Name', B1: '' });

    const ctxPromise = collectDOMContext();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await ctxPromise).toEqual({
      activeCell: 'D10',
      formulaBar: '=SUM(A1:A10)',
      spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      sheetGid: '7',
      sheetName: 'Sheet1',
      columnHeaders: ['Name'],
      availableSheets: ['Sheet1', 'Sheet2'],
    });
  });

  it('defaults spreadsheetId to an empty string on a non-spreadsheet URL', async () => {
    window.history.replaceState(null, '', '/notasheet');
    simulateSheetsResponding({ A1: '' });

    const ctxPromise = collectDOMContext();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await ctxPromise).spreadsheetId).toBe('');
  });
});

// --- safeKeyTarget ---

describe('safeKeyTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a focused button element', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    expect(safeKeyTarget()).toBe(btn);
  });

  it('falls back to #waffle-rich-text-editor when nothing focused', () => {
    const editor = document.createElement('div');
    editor.id = 'waffle-rich-text-editor';
    document.body.appendChild(editor);
    // blur so body is activeElement
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(safeKeyTarget()).toBe(editor);
  });

  it('falls back to document.body when editor not in DOM', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(safeKeyTarget()).toBe(document.body);
  });
});

// --- readFormulaBar ---

describe('readFormulaBar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns formula text from the formula bar element', () => {
    document.body.innerHTML = `
      <div id="t-formula-bar-input-container">
        <div class="cell-input">=SUM(A1:A10)</div>
      </div>
    `;
    expect(readFormulaBar()).toBe('=SUM(A1:A10)');
  });

  it('returns empty string when formula bar element is absent', () => {
    expect(readFormulaBar()).toBe('');
  });
});

// --- readActiveCell ---

describe('readActiveCell', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the name box input value', () => {
    document.body.innerHTML = `<input id="t-name-box" class="waffle-name-box" value="B7" />`;
    expect(readActiveCell()).toBe('B7');
  });

  it('returns empty string when name box is absent', () => {
    expect(readActiveCell()).toBe('');
  });
});

// --- listSheets ---

describe('listSheets', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns visible label names, ignoring hidden SVG comment-count text', () => {
    // Mirrors real Sheets DOM: hidden "0" node + visible .docs-sheet-tab-name span
    document.body.innerHTML = `
      <div class="docs-sheet-tab">
        <span style="display:none">0</span>
        <span class="docs-sheet-tab-name">Sheet1</span>
      </div>
      <div class="docs-sheet-tab">
        <span style="display:none">0</span>
        <span class="docs-sheet-tab-name">Sheet2</span>
      </div>
      <div class="docs-sheet-tab">
        <span style="display:none">0</span>
        <span class="docs-sheet-tab-name">Data</span>
      </div>
    `;
    expect(listSheets()).toEqual(['Sheet1', 'Sheet2', 'Data']);
  });

  it('returns empty array when no tabs exist', () => {
    expect(listSheets()).toEqual([]);
  });
});

// --- activeSheetName ---

describe('activeSheetName', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns name of the active tab via .docs-sheet-tab-name span', () => {
    document.body.innerHTML = `
      <div class="docs-sheet-tab">
        <span class="docs-sheet-tab-name">Sheet1</span>
      </div>
      <div class="docs-sheet-tab docs-sheet-active-tab">
        <span class="docs-sheet-tab-name">Sheet2</span>
      </div>
    `;
    expect(activeSheetName()).toBe('Sheet2');
  });

  it('returns empty string when no tab has the active class', () => {
    document.body.innerHTML = `
      <div class="docs-sheet-tab">
        <span class="docs-sheet-tab-name">Sheet1</span>
      </div>
    `;
    expect(activeSheetName()).toBe('');
  });
});

// --- typeText focus guard ---

describe('typeText focus guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('throws when another element holds focus', () => {
    const editor = document.createElement('div');
    editor.id = 'waffle-rich-text-editor';
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();

    expect(() => typeText('hello')).toThrow(/typeText aborted/i);
  });

  it('throws when editor element is absent', () => {
    expect(() => typeText('hello')).toThrow(/waffle-rich-text-editor/i);
  });
});

// --- writeToSelectedCell ---

describe('writeToSelectedCell', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('throws when formula bar element is absent', async () => {
    await expect(writeToSelectedCell('=SUM(A1:A10)')).rejects.toThrow(/formula bar/i);
  });

  it('resolves without throwing when formula bar is present', async () => {
    document.body.innerHTML = `
      <div id="t-formula-bar-input">
        <div class="cell-input">old content</div>
      </div>
      <div id="waffle-rich-text-editor" contenteditable="true"></div>
    `;
    // jsdom Selection API is limited — we just assert it doesn't throw
    await expect(writeToSelectedCell('=SUM(A1:A10)')).resolves.toBeUndefined();
  });
});

// --- getShortcutDef ---

describe('getShortcutDef', () => {
  it('returns mac bold shortcut with metaKey', () => {
    const def = getShortcutDef('bold', 'mac');
    expect(def).toMatchObject({ key: 'b', code: 'KeyB', metaKey: true });
    expect(def.ctrlKey).toBeFalsy();
  });

  it('returns pc bold shortcut with ctrlKey', () => {
    const def = getShortcutDef('bold', 'pc');
    expect(def).toMatchObject({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(def.metaKey).toBeFalsy();
  });

  it('throws for unknown shortcut id', () => {
    expect(() => getShortcutDef('nonexistent', 'mac')).toThrow(/unknown shortcut/i);
  });
});
