import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Explain } from "../explain/Explain";
import { nextSort, sortFromParams, sortRows, writeSortParams, type SortColumns, type SortState } from "../lib/sort";

/** What a sortable header needs to know, the current sort and what a click does. */
export interface SortControl {
  sort: SortState | null;
  onSort: (key: string) => void;
}

/** Sorts rows held in the browser. Use it only when the rows are the whole list, not one page of it. */
export function useSort<T>(rows: readonly T[], columns: SortColumns<T>): SortControl & { rows: readonly T[] } {
  const [sort, setSort] = useState<SortState | null>(null);
  const value = sort ? columns[sort.key] : undefined;
  const sorted = useMemo(() => (sort && value ? sortRows(rows, value, sort.dir) : rows), [rows, sort, value]);
  return { sort, onSort: (key) => setSort((s) => nextSort(s, key)), rows: sorted };
}

/** The sort for a paginated table. It lives in the address and the server sorts every page. */
export function useUrlSort(keys: readonly string[]): SortControl {
  const [sp, setSp] = useSearchParams();
  const sort = sortFromParams(sp, keys);
  return { sort, onSort: (key) => setSp(writeSortParams(sp, nextSort(sort, key)), { replace: true }) };
}

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

/**
 * A column header that sorts. The hint mark sits beside the button, because a button may not hold another button.
 * The icon sits in the cell's padding, so a header keeps its width when the sort changes.
 */
export function SortableTh({
  sortKey,
  control,
  explain,
  className,
  style,
  children,
}: {
  sortKey: string;
  control: SortControl;
  explain?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const dir = control.sort?.key === sortKey ? control.sort.dir : null;
  const Icon = dir === "asc" ? ArrowUp : dir === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <th scope="col" className={className} style={style} aria-sort={dir ? ARIA_SORT[dir] : "none"}>
      <button type="button" className="th-sort" onClick={() => control.onSort(sortKey)}>
        <span>{children}</span>
        <Icon className="th-sort-icon" aria-hidden="true" />
      </button>
      {explain && <Explain id={explain} />}
    </th>
  );
}
