import { describe, it, expect } from 'vitest';
import { buildUserMessage, type DOMContext } from './utils';

const baseCtx: DOMContext = {
  activeCell: 'B7',
  formulaBar: '=SUM(A1:A10)',
  spreadsheetId: 'abc123',
  sheetGid: '0',
  sheetName: 'Sheet1',
  columnHeaders: ['Name', 'Sales', 'Revenue'],
  availableSheets: ['Sheet1', 'Data'],
};

describe('buildUserMessage', () => {
  it('includes active cell and question', () => {
    const msg = buildUserMessage('sum column B', baseCtx);
    expect(msg).toContain('Active cell: B7');
    expect(msg).toContain('sum column B');
  });

  it('shows (empty) when formulaBar is blank', () => {
    const msg = buildUserMessage('q', { ...baseCtx, formulaBar: '' });
    expect(msg).toContain('Formula bar: (empty)');
  });

  it('shows (none detected) when columnHeaders is empty', () => {
    const msg = buildUserMessage('q', { ...baseCtx, columnHeaders: [] });
    expect(msg).toContain('Column headers: (none detected)');
  });

  it('joins columnHeaders with comma', () => {
    const msg = buildUserMessage('q', baseCtx);
    expect(msg).toContain('Name, Sales, Revenue');
  });

  it('includes sheet name and gid', () => {
    const msg = buildUserMessage('q', baseCtx);
    expect(msg).toContain('Sheet1 (gid: 0)');
  });

  it('includes spreadsheet ID', () => {
    const msg = buildUserMessage('q', baseCtx);
    expect(msg).toContain('Spreadsheet ID: abc123');
  });

  it('includes available sheets', () => {
    const msg = buildUserMessage('q', baseCtx);
    expect(msg).toContain('Sheet1, Data');
  });
});
