import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectOS,
  readSpreadsheetId,
  safeKeyTarget,
  readFormulaBar,
  readActiveCell,
  listSheets,
  activeSheetName,
  getShortcutDef,
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

  it('returns the name box text content', () => {
    document.body.innerHTML = `<div class="docs-name-box">B7</div>`;
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

  it('returns all sheet tab names in order', () => {
    document.body.innerHTML = `
      <div class="docs-sheet-tab">Sheet1</div>
      <div class="docs-sheet-tab">Sheet2</div>
      <div class="docs-sheet-tab">Data</div>
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

  it('returns name of the tab with the active class', () => {
    document.body.innerHTML = `
      <div class="docs-sheet-tab">Sheet1</div>
      <div class="docs-sheet-tab docs-sheet-active-tab">Sheet2</div>
    `;
    expect(activeSheetName()).toBe('Sheet2');
  });

  it('returns empty string when no tab has the active class', () => {
    document.body.innerHTML = `<div class="docs-sheet-tab">Sheet1</div>`;
    expect(activeSheetName()).toBe('');
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
