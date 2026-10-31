// Indian-style number formatting: 4,50,00,000 and lakh / crore abbreviations.

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const NBSP = " ";

/** ₹4,50,00,000 */
export function rupees(n: number | null | undefined, decimals = false): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const sign = n < 0 ? "−" : "";
  return `${sign}₹${(decimals ? inr2 : inr).format(Math.abs(n))}`;
}

/** ₹4.5 cr, ₹82.4 L, ₹45,000 */
export function rupeesShort(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7, a >= 1e9 ? 0 : 2)}${NBSP}cr`;
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5, 2)}${NBSP}L`;
  return `${sign}₹${inr.format(a)}`;
}

function trim(x: number, digits: number) {
  const s = x.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s; // drop trailing decimals only, never integer zeros
}

/** 1,00,000 grouping, no currency */
export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** 0.0182 -> "1.82%" */
export function pctFromRatio(r: number | null | undefined, digits = 2): string {
  if (r === null || r === undefined || Number.isNaN(r)) return "–";
  return `${(r * 100).toFixed(digits)}%`;
}

/** 10.4 -> "10.40%" */
export function pct(p: number | null | undefined, digits = 2): string {
  if (p === null || p === undefined || Number.isNaN(p)) return "–";
  return `${p.toFixed(digits)}%`;
}

export function months(m: number | null | undefined): string {
  if (m === null || m === undefined) return "–";
  return `${m}${NBSP}mo`;
}

const dtf = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const dtfTime = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function date(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf.format(d);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtfTime.format(d);
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)}${NBSP}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}${NBSP}s`;
  return `${Math.floor(s / 60)}m${NBSP}${Math.round(s % 60)}s`;
}

/** Formats a raw cell from a node record table using its column name as a hint. */
export function cell(column: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    const c = column.toLowerCase();
    if (/(amount|balance|sanctioned|overdue|exposure|turnover|tax_paid|limit|value|requested)/.test(c)) return rupees(v, !Number.isInteger(v));
    if (/(pct|share)/.test(c)) return `${v.toFixed(2)}%`;
    if (/(_id|year)$/.test(c) || c === "id") return String(v);
    return num(v, Number.isInteger(v) ? 0 : 2);
  }
  return String(v);
}

export function isNumericColumn(column: string, sample: unknown): boolean {
  return typeof sample === "number" && !/(_id|year)$/.test(column.toLowerCase());
}

export function humanize(col: string): string {
  const s = col.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
