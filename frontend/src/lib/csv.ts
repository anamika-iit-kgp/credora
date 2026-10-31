// CSV export: what a table shows, as a file the browser downloads.

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

function cell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote when needed (RFC 4180), and defuse spreadsheet formulas in text cells.
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(","), ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(","))];
  return lines.join("\r\n") + "\r\n";
}

/** credora-whatif-runs-20261031.csv (local date). */
export function csvName(stem: string, d = new Date()): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `credora-${stem}-${ymd}.csv`;
}

export function downloadCsv<T>(fileName: string, columns: CsvColumn<T>[], rows: T[]): void {
  // A byte-order mark so spreadsheet programs read ₹ and other non-ASCII text as UTF-8.
  const blob = new Blob(["﻿", toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
