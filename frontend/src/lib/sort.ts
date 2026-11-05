// Table sorting. One comparator for every sortable column in the app, and the three-step header cycle.

export type SortValue = string | number | boolean | Date | null | undefined;
export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}
export type SortColumns<T> = Record<string, (row: T) => SortValue>;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "accent" });
const NUMERIC_TEXT = /^[+-]?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;

type Normal = { kind: 0 | 1; n: number } | { kind: 2; s: string } | null;

/** What a value sorts as. Numbers and numeric text are kind 0, dates kind 1, other text kind 2, and blanks are null. */
function normal(v: SortValue): Normal {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : { kind: 0, n: v };
  if (typeof v === "boolean") return { kind: 0, n: v ? 1 : 0 };
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : { kind: 1, n: t };
  }
  const s = v.trim();
  if (!s) return null;
  if (NUMERIC_TEXT.test(s)) return { kind: 0, n: Number(s) };
  if (ISO_DATE.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return { kind: 1, n: t };
  }
  return { kind: 2, s };
}

function compareNormal(a: Normal, b: Normal, dir: SortDir): number {
  // Blanks go last in both directions, so this check comes before the direction is applied.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  let c: number;
  if (a.kind === 2 && b.kind === 2) c = collator.compare(a.s, b.s);
  else if (a.kind !== 2 && b.kind !== 2 && a.kind === b.kind) c = a.n - b.n;
  else c = a.kind - b.kind;
  return dir === "desc" ? -c : c;
}

export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir = "asc"): number {
  return compareNormal(normal(a), normal(b), dir);
}

/** A sorted copy. The input is never changed and rows that tie keep their original order, in both directions. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i, v: normal(value(row)) }))
    .sort((x, y) => compareNormal(x.v, y.v, dir) || x.i - y.i)
    .map((x) => x.row);
}

/** One click on a header goes ascending, then descending, then back to the table's original order. */
export function nextSort(current: SortState | null, key: string): SortState | null {
  if (current?.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

/** The position of a label in its working order, for columns that read better in that order than alphabetically. */
export function ordinal(order: readonly string[], v: string | null | undefined): number | null {
  const i = v == null ? -1 : order.indexOf(v);
  return i < 0 ? null : i;
}

export const DECISION_ORDER = ["APPROVE", "REFER", "DECLINE"];
export const GST_STAGE_ORDER = ["New", "Mid-level", "Stable"];
export const OFFER_STAGE_ORDER = ["OFFERED", "NEGOTIATING", "ESCALATED", "VERIFIED", "SANCTIONED", "DECLINED"];

export const decisionRank = (d: string | null | undefined) => ordinal(DECISION_ORDER, d);
export const offerStageRank = (s: string | null | undefined) => ordinal(OFFER_STAGE_ORDER, s);

/** The sort named in a page's address, for tables sorted by the server. A key the page does not offer is ignored. */
export function sortFromParams(sp: URLSearchParams, keys: readonly string[]): SortState | null {
  const key = sp.get("sort");
  if (!key || !keys.includes(key)) return null;
  return { key, dir: sp.get("order") === "desc" ? "desc" : "asc" };
}

/** Writes a sort into the address and goes back to page 1, because the old page number means nothing in a new order. */
export function writeSortParams(sp: URLSearchParams, sort: SortState | null): URLSearchParams {
  const n = new URLSearchParams(sp);
  n.delete("page");
  n.delete("sort");
  n.delete("order");
  if (sort) {
    n.set("sort", sort.key);
    n.set("order", sort.dir);
  }
  return n;
}
