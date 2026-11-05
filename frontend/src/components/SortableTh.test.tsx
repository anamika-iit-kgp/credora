import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyFilter } from "../api/hooks";
import type { CompanyRow } from "../api/types";
import { CompaniesPage } from "../pages/explorer/Companies";
import { SortableTh, useSort } from "./SortableTh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen: CompanyFilter[] = [];
vi.mock("../api/hooks", () => ({
  useCompanies: (f: CompanyFilter) => {
    seen.push(f);
    const items: Partial<CompanyRow>[] = [{ cif_id: "C000002", legal_name: "Beta", stage: "New", partners: 2 }];
    return { data: { items, total: 60, page: f.page, size: f.size }, isFetching: false, isLoading: false, isError: false };
  },
}));
vi.mock("../auth/AuthContext", () => ({ useUser: () => ({ role: "admin", username: "admin" }) }));

interface Row {
  id: string;
  amount: number | null;
}
const ROWS: readonly Row[] = Object.freeze([
  { id: "C000010", amount: 500 },
  { id: "C000009", amount: null },
  { id: "C000011", amount: 90 },
]);
const COLUMNS = { id: (r: Row) => r.id, amount: (r: Row) => r.amount };

/** A small table with a checkbox in each row, to prove that row state follows the row and not its position. */
function Demo() {
  const sort = useSort(ROWS, COLUMNS);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <table>
      <thead>
        <tr>
          <SortableTh sortKey="id" control={sort}>CIF</SortableTh>
          <SortableTh sortKey="amount" control={sort} className="r">Offer</SortableTh>
        </tr>
      </thead>
      <tbody>
        {sort.rows.map((r) => (
          <tr key={r.id} data-id={r.id}>
            <td>
              <input type="checkbox" checked={picked === r.id} onChange={() => setPicked(r.id)} aria-label={r.id} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  seen.length = 0;
});

const order = () => [...host.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-id"));
const header = (name: string) => [...host.querySelectorAll("th")].find((t) => t.textContent === name)!;
const click = (el: Element) => act(() => (el as HTMLElement).click());
const press = (name: string) => click(header(name).querySelector("button")!);

describe("a sortable header", () => {
  beforeEach(() => act(() => root.render(<Demo />)));

  it("starts in the table's own order with aria-sort none on every column", () => {
    expect(order()).toEqual(["C000010", "C000009", "C000011"]);
    expect(header("CIF").getAttribute("aria-sort")).toBe("none");
    expect(header("Offer").getAttribute("aria-sort")).toBe("none");
  });

  it("is a real button, and goes ascending, descending, then back to the original order", () => {
    expect(header("CIF").querySelector("button")?.type).toBe("button");
    press("CIF");
    expect(order()).toEqual(["C000009", "C000010", "C000011"]);
    expect(header("CIF").getAttribute("aria-sort")).toBe("ascending");
    press("CIF");
    expect(order()).toEqual(["C000011", "C000010", "C000009"]);
    expect(header("CIF").getAttribute("aria-sort")).toBe("descending");
    press("CIF");
    expect(order()).toEqual(["C000010", "C000009", "C000011"]);
    expect(header("CIF").getAttribute("aria-sort")).toBe("none");
  });

  it("moves aria-sort to the column sorted last and keeps blanks last both ways", () => {
    press("CIF");
    press("Offer");
    expect(header("CIF").getAttribute("aria-sort")).toBe("none");
    expect(header("Offer").getAttribute("aria-sort")).toBe("ascending");
    expect(order()).toEqual(["C000011", "C000010", "C000009"]);
    press("Offer");
    expect(order()).toEqual(["C000010", "C000011", "C000009"]);
  });

  it("always has one icon, so nothing moves when the sort changes", () => {
    for (let i = 0; i < 3; i++) {
      expect(header("CIF").querySelectorAll("svg.th-sort-icon")).toHaveLength(1);
      press("CIF");
    }
  });

  it("does not touch the query data", () => {
    press("Offer");
    expect(ROWS.map((r) => r.id)).toEqual(["C000010", "C000009", "C000011"]);
  });

  it("keeps a row's checkbox with that row after sorting", () => {
    click(host.querySelector('input[aria-label="C000010"]')!);
    press("CIF");
    press("CIF");
    const picked = host.querySelector<HTMLInputElement>("input:checked")!;
    expect(picked.getAttribute("aria-label")).toBe("C000010");
    expect(picked.closest("tr")!.getAttribute("data-id")).toBe("C000010");
  });
});

describe("the data explorer table", () => {
  beforeEach(() =>
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/companies?page=3&stage=New"]}>
          <CompaniesPage />
        </MemoryRouter>,
      ),
    ),
  );

  it("asks the server to sort, since it holds only one page, and goes back to page 1", () => {
    expect(seen.at(-1)).toMatchObject({ page: 3, stage: "New", sort: undefined, order: undefined });
    press("Offer");
    expect(seen.at(-1)).toMatchObject({ page: 1, stage: "New", sort: "offer_amount", order: "asc" });
    expect(header("Offer").getAttribute("aria-sort")).toBe("ascending");
    press("Offer");
    expect(seen.at(-1)).toMatchObject({ page: 1, sort: "offer_amount", order: "desc" });
    press("Offer");
    expect(seen.at(-1)).toMatchObject({ page: 1, stage: "New", sort: undefined, order: undefined });
    expect(header("Offer").getAttribute("aria-sort")).toBe("none");
  });
});
