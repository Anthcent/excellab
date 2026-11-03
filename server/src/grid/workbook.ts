import { badRequest } from "../http/errors.js";
import { GridEngine, type Workbook } from "./engine.js";

/** Limits applied to every workbook that comes from a client (the request body is also capped at ~1 MB). */
export const WORKBOOK_LIMITS = { maxSheets: 20, maxCells: 8000, maxStr: 2000 };

/** Validates and cleans an incoming workbook. Throws a 400 AppError when it is malformed or too big. */
export function parseWorkbook(raw: unknown): Workbook {
  try {
    return GridEngine.sanitizeWorkbook(raw, WORKBOOK_LIMITS);
  } catch {
    throw badRequest("El libro enviado no es válido o es demasiado grande.", "INVALID_WORKBOOK");
  }
}

/** Same sanitizer for data read from the database (never trust stored JSON blindly either). */
export function storedWorkbook(raw: unknown): Workbook {
  return GridEngine.sanitizeWorkbook(raw, { maxSheets: 50, maxCells: 20000, maxStr: 4000 });
}
