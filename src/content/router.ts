import type { PrimitiveResult } from '../types/messages';
import {
  readFormulaBar,
  readActiveCell,
  readCellError,
  readSpreadsheetId,
  listSheets,
  activeSheetName,
  detectOS,
  selectCell,
  selectRange,
  navigateToSheet,
  enterEditMode,
  typeText,
  writeToSelectedCell,
  commitCell,
  pressEscape,
  dispatchShortcut,
} from './primitives';

type PrimitiveFn = (...args: unknown[]) => unknown | Promise<unknown>;

const PRIMITIVES: Record<string, PrimitiveFn> = {
  readFormulaBar,
  readActiveCell,
  readCellError,
  readSpreadsheetId: (url?: unknown) => readSpreadsheetId(url as string | undefined),
  listSheets,
  activeSheetName,
  detectOS,
  selectCell: (ref: unknown) => selectCell(ref as string),
  selectRange: (start: unknown, end: unknown) => selectRange(start as string, end as string),
  navigateToSheet: (name: unknown) => navigateToSheet(name as string),
  enterEditMode,
  typeText: (text: unknown, opts?: unknown) => typeText(text as string, opts as { overwrite?: boolean } | undefined),
  writeToSelectedCell: (text: unknown) => writeToSelectedCell(text as string),
  commitCell,
  pressEscape,
  dispatchShortcut: (id: unknown) => dispatchShortcut(id as string),
};

export async function handlePrimitive(name: string, args: unknown[] = []): Promise<PrimitiveResult> {
  const fn = PRIMITIVES[name];
  if (!fn) {
    return { ok: false, error: `Unknown primitive: "${name}"` };
  }
  try {
    const result = await fn(...args);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
