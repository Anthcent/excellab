export type CsvValue = string | number | boolean | null | undefined;

/** Delimiter for Spanish-locale Excel, where ',' is the decimal separator. */
export const CSV_DELIMITER = ";";
const BOM = "﻿";

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value).replace(".", ",") : "";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  // Spreadsheet formula injection: text that would be read as a formula is forced to plain text.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 with BOM, ';' delimiter, CRLF line endings: opens correctly in Spanish Excel. */
export function toCsv(header: string[], rows: CsvValue[][]): string {
  return BOM + [header, ...rows].map((row) => row.map(cell).join(CSV_DELIMITER)).join("\r\n") + "\r\n";
}
