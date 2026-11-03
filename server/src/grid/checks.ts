import { z } from "zod";
import { GridEngine, type AstNode, type Engine, type Workbook } from "./engine.js";

/* ---------- Check definitions (what an exercise author writes) ---------- */

const points = z.number().positive().max(1000).default(1);
const label = z.string().trim().max(200).optional();
const sheetName = z.string().trim().min(1).max(31).optional();
const address = z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}[0-9]{1,4}$/, "Invalid cell address");
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);

export const checkSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cell_value"),
    sheet: sheetName,
    cell: address,
    expected: scalar,
    tolerance: z.number().min(0).max(1e9).optional(),
    ignoreCase: z.boolean().optional(),
    requireFormula: z.boolean().optional(),
    points,
    label,
  }),
  z.object({
    type: z.literal("cell_formula_uses"),
    sheet: sheetName,
    cell: address,
    functions: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
    points,
    label,
  }),
  z.object({
    type: z.literal("range_values"),
    sheet: sheetName,
    range: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}[0-9]{1,4}:[A-Z]{1,3}[0-9]{1,4}$/, "Invalid range"),
    expected: z.array(z.array(scalar).min(1).max(26)).min(1).max(200),
    tolerance: z.number().min(0).max(1e9).optional(),
    ignoreCase: z.boolean().optional(),
    points,
    label,
  }),
]);
export const checksSchema = z.array(checkSchema).max(50);
export type Check = z.infer<typeof checkSchema>;

/* ---------- Results ---------- */

/** Stored in attempt_answers.details. `ref` and `actual` are for staff only; students never receive them. */
export interface CheckResult {
  index: number;
  label: string;
  points: number;
  earned: number;
  passed: boolean;
  type: Check["type"];
  ref: string;
  actual?: string;
}
export interface GradeOutcome {
  score: number;
  maxScore: number;
  results: CheckResult[];
}
export interface StudentCheckResult {
  label: string;
  points: number;
  earned: number;
  passed: boolean;
}

/** What a student may see about a graded exercise: pass/fail per check, nothing about expected values. */
export const toStudentResults = (results: CheckResult[]): StudentCheckResult[] =>
  results.map(({ label, points, earned, passed }) => ({ label, points, earned, passed }));

/* ---------- Grading ---------- */

/** Work budget per check, see spend() in engine.js. Bounds heavy workbooks and long loops. */
export const EVAL_BUDGET = 400_000;
const DEFAULT_TOLERANCE = 1e-6;
const round2 = (x: number) => Math.round(x * 100) / 100;

function newEngine(workbook: Workbook): Engine {
  const eng = GridEngine.createEngine({ workbook, decimal: "." });
  eng.S.budget = EVAL_BUDGET;
  return eng;
}

function valueMatches(eng: Engine, actual: unknown, expected: string | number | boolean, tolerance?: number, ignoreCase?: boolean) {
  if (eng.isErr(actual)) return false;
  if (typeof expected === "number") {
    if (typeof actual !== "number") return false;
    const tol = tolerance ?? DEFAULT_TOLERANCE;
    return Math.abs(actual - expected) <= tol + 1e-9 * Math.abs(expected);
  }
  if (typeof expected === "boolean") return actual === expected;
  const text = actual === null || actual === undefined ? "" : typeof actual === "string" ? actual : eng.toStr(actual);
  return ignoreCase ? text.toLowerCase() === expected.toLowerCase() : text === expected;
}

function show(eng: Engine, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (eng.isErr(value)) return String(value);
  return String(value).slice(0, 200);
}

function functionsUsed(eng: Engine, node: AstNode | undefined, out: Set<string>) {
  if (!node) return;
  if (node.t === "fn" && node.name) out.add(eng.resolveFn(node.name) ?? node.name.toUpperCase());
  for (const child of [node.l, node.r, node.e, ...(node.args ?? [])]) functionsUsed(eng, child, out);
}

interface Evaluated {
  passed: boolean;
  ref: string;
  actual?: string;
}

function evaluate(eng: Engine, workbook: Workbook, check: Check): Evaluated {
  const si = check.sheet ? eng.sheetIndex(check.sheet) : 0;
  const sheet = workbook.sheets[si];
  if (!sheet) return { passed: false, ref: check.type === "range_values" ? check.range : check.cell };

  switch (check.type) {
    case "cell_value": {
      const pos = eng.parseA(check.cell);
      if (!pos) return { passed: false, ref: check.cell };
      const actual = eng.cellValue(si, pos.r, pos.c);
      let passed = valueMatches(eng, actual, check.expected, check.tolerance, check.ignoreCase);
      if (passed && check.requireFormula) {
        const cell = sheet.cells[check.cell];
        passed = !!cell && cell.v.startsWith("=") && cell.v.length > 1 && !cell.str;
      }
      return { passed, ref: check.cell, actual: show(eng, actual) };
    }
    case "cell_formula_uses": {
      const cell = sheet.cells[check.cell];
      if (!cell || !cell.v.startsWith("=") || cell.str) return { passed: false, ref: check.cell, actual: cell ? cell.v.slice(0, 200) : "" };
      const used = new Set<string>();
      functionsUsed(eng, eng.getAst(cell.v), used);
      const passed = check.functions.every((name) => used.has(eng.resolveFn(name) ?? name.toUpperCase()));
      return { passed, ref: check.cell, actual: cell.v.slice(0, 200) };
    }
    case "range_values": {
      const range = eng.parseRangeText(check.range);
      if (!range) return { passed: false, ref: check.range };
      const rows = range.r2 - range.r1 + 1;
      const cols = range.c2 - range.c1 + 1;
      if (check.expected.length !== rows || check.expected.some((row) => row.length !== cols)) {
        return { passed: false, ref: check.range, actual: "bad expected shape" };
      }
      let passed = true;
      for (let r = 0; r < rows && passed; r++) {
        for (let c = 0; c < cols; c++) {
          const actual = eng.cellValue(si, range.r1 + r, range.c1 + c);
          if (!valueMatches(eng, actual, check.expected[r]![c]!, check.tolerance, check.ignoreCase)) {
            passed = false;
            break;
          }
        }
      }
      return { passed, ref: check.range };
    }
  }
}

/**
 * Recalculates the workbook with the shared engine and evaluates every check. Cached values sent by
 * the client are never read: only the raw cell contents are used.
 * A check that throws (heavy formula, budget exceeded, engine bug) simply fails.
 */
export function gradeWorkbook(workbook: Workbook, checks: Check[], exercisePoints: number): GradeOutcome {
  const total = checks.reduce((sum, c) => sum + c.points, 0);
  const factor = total > 0 ? exercisePoints / total : 0;
  let eng = newEngine(workbook);
  const results: CheckResult[] = checks.map((check, index) => {
    let outcome: Evaluated;
    try {
      outcome = evaluate(eng, workbook, check);
    } catch {
      outcome = { passed: false, ref: check.type === "range_values" ? check.range : check.cell };
      eng = newEngine(workbook); // the previous engine may be half-evaluated after an abort
    }
    const scaled = round2(check.points * factor);
    return {
      index,
      label: check.label || `Verificación ${index + 1}`,
      points: scaled,
      earned: outcome.passed ? scaled : 0,
      passed: outcome.passed,
      type: check.type,
      ref: outcome.ref,
      ...(outcome.actual !== undefined && { actual: outcome.actual }),
    };
  });
  const score = Math.min(exercisePoints, round2(results.reduce((sum, r) => sum + r.earned, 0)));
  return { score, maxScore: exercisePoints, results };
}
