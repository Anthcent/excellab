import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The server grades with the very same engine file the browser runs (src/engine.js).
 * The file is an IIFE that assigns GridEngine on the object it receives as `globalThis`,
 * so evaluating it with a private holder keeps the real global untouched.
 */

export interface GridCell {
  v: string;
  str?: 1;
  s?: Record<string, unknown>;
}
export interface GridSheet {
  name: string;
  cells: Record<string, GridCell>;
  colW: Record<string, number>;
  sel?: { ar: number; ac: number; fr: number; fc: number };
  hiddenRows?: number[];
}
export interface Workbook {
  name: string;
  sheets: GridSheet[];
}

export interface Engine {
  S: { wb: Workbook; cur: number; DEC: string; budget: number };
  ROWS: number;
  COLS: number;
  cellValue(sheetIndex: number, row: number, col: number): unknown;
  sheetIndex(name: string): number;
  parseA(a: string): { r: number; c: number } | null;
  parseRangeText(t: string): { r1: number; c1: number; r2: number; c2: number } | null;
  isErr(v: unknown): boolean;
  toStr(v: unknown): string;
  errText(e: string): string;
  evalFormulaText(text: string, sheetIndex?: number): unknown;
  getAst(src: string): AstNode;
  resolveFn(name: string): string | null;
  recalc(): void;
  circular: Set<string>;
  shiftFormula(f: string, dr: number, dc: number): string;
  toLocalFormula(f: string): string;
  toCanonFormula(f: string): string;
}

export interface AstNode {
  t: string;
  name?: string;
  args?: AstNode[];
  l?: AstNode;
  r?: AstNode;
  e?: AstNode;
}

interface GridEngineApi {
  createEngine(opts?: { workbook?: Workbook; decimal?: string; current?: number }): Engine;
  sanitizeWorkbook(raw: unknown, limits?: { maxSheets?: number; maxCells?: number; maxStr?: number }): Workbook;
  ROWS: number;
  COLS: number;
}

const enginePath = fileURLToPath(new URL("../../../src/engine.js", import.meta.url));
const holder: { GridEngine?: GridEngineApi } = {};
new Function("globalThis", readFileSync(enginePath, "utf8"))(holder);

if (!holder.GridEngine) throw new Error(`Could not load the grid engine from ${enginePath}`);
export const GridEngine: GridEngineApi = holder.GridEngine;
