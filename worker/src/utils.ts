export interface DOMContext {
  activeCell: string;
  formulaBar: string;
  spreadsheetId: string;
  sheetGid: string;
  sheetName: string;
  columnHeaders: string[];
  availableSheets: string[];
}

export function buildUserMessage(question: string, ctx: DOMContext): string {
  return `## Spreadsheet context
- Active cell: ${ctx.activeCell}
- Formula bar: ${ctx.formulaBar || '(empty)'}
- Sheet: ${ctx.sheetName} (gid: ${ctx.sheetGid})
- Spreadsheet ID: ${ctx.spreadsheetId}
- Column headers: ${ctx.columnHeaders.length ? ctx.columnHeaders.join(', ') : '(none detected)'}
- Available sheets: ${ctx.availableSheets.join(', ')}

## User request
${question}`;
}
