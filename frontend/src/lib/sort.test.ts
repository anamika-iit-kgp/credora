import { describe, expect, it } from "vitest";
import { compareSortValues, decisionRank, nextSort, ordinal, sortFromParams, sortRows, writeSortParams, type SortValue } from "./sort";

const sorted = (xs: SortValue[], dir: "asc" | "desc" = "asc") => sortRows(xs, (x) => x, dir);

describe("sortRows", () => {
  it("sorts numbers as numbers, not as text", () => {
    expect(sorted([10, 9, 100, 1.5, -2])).toEqual([-2, 1.5, 9, 10, 100]);
    expect(sorted([10, 9, 100, 1.5, -2], "desc")).toEqual([100, 10, 9, 1.5, -2]);
  });

  it("sorts numeric text with decimals as numbers", () => {
    expect(sorted(["12.5", "12.45", "9", "100"])).toEqual(["9", "12.45", "12.5", "100"]);
  });

  it("puts C000010 after C000009, and C10 after C9", () => {
    expect(sorted(["C000010", "C000009", "C000011"])).toEqual(["C000009", "C000010", "C000011"]);
    expect(sorted(["C10", "C9", "C100"])).toEqual(["C9", "C10", "C100"]);
    expect(sorted(["v10", "v4", "v4-lr"])).toEqual(["v4", "v4-lr", "v10"]);
  });

  it("ignores case in text", () => {
    expect(sorted(["banana", "Apple", "cherry", "apple 2"])).toEqual(["Apple", "apple 2", "banana", "cherry"]);
  });

  it("sorts dates by time, across timezones and against Date objects", () => {
    expect(sorted(["2026-11-02T10:00:00+05:30", "2026-11-02T01:00:00Z", "2026-11-01"])).toEqual(["2026-11-01", "2026-11-02T01:00:00Z", "2026-11-02T10:00:00+05:30"]);
    const a = new Date("2026-01-01");
    const b = new Date("2025-01-01");
    expect(sorted([a, b])).toEqual([b, a]);
  });

  it("keeps blanks last in both directions", () => {
    const xs: SortValue[] = [null, 3, undefined, 1, "", "  ", NaN, 2];
    for (const dir of ["asc", "desc"] as const) {
      const out = sorted(xs, dir);
      expect(out.slice(0, 3)).toEqual(dir === "asc" ? [1, 2, 3] : [3, 2, 1]);
      expect(out.slice(3)).toEqual([null, undefined, "", "  ", NaN]);
    }
    expect(String(sorted([new Date("nonsense"), new Date("2026-01-01")])[1])).toBe("Invalid Date");
  });

  it("is stable in both directions", () => {
    const rows = [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "c", v: 1 },
      { id: "d", v: 2 },
    ];
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.id)).toEqual(["a", "c", "b", "d"]);
    expect(sortRows(rows, (r) => r.v, "desc").map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("returns a copy and leaves frozen query data alone", () => {
    const rows = Object.freeze([3, 1, 2]);
    expect(sortRows(rows, (x) => x, "asc")).toEqual([1, 2, 3]);
    expect(rows).toEqual([3, 1, 2]);
  });

  it("keeps one order when a column mixes kinds", () => {
    const out = sorted(["text", 5, "2026-01-01", 1]);
    expect(out).toEqual([1, 5, "2026-01-01", "text"]);
    expect(compareSortValues(5, "text")).toBeLessThan(0);
    expect(compareSortValues("text", 5)).toBeGreaterThan(0);
  });
});

describe("nextSort", () => {
  it("goes ascending, descending, then back to the original order", () => {
    const one = nextSort(null, "a");
    expect(one).toEqual({ key: "a", dir: "asc" });
    const two = nextSort(one, "a");
    expect(two).toEqual({ key: "a", dir: "desc" });
    expect(nextSort(two, "a")).toBeNull();
  });

  it("starts ascending on a different column", () => {
    expect(nextSort({ key: "a", dir: "desc" }, "b")).toEqual({ key: "b", dir: "asc" });
  });
});

describe("ordinal", () => {
  it("gives the working order, and nothing for an unknown label", () => {
    expect(decisionRank("APPROVE")).toBe(0);
    expect(decisionRank("DECLINE")).toBe(2);
    expect(decisionRank(null)).toBeNull();
    expect(ordinal(["a"], "b")).toBeNull();
  });
});

describe("the sort in the address", () => {
  const keys = ["legal_name", "pd"];

  it("reads a known key and ignores any other", () => {
    expect(sortFromParams(new URLSearchParams("sort=pd&order=desc"), keys)).toEqual({ key: "pd", dir: "desc" });
    expect(sortFromParams(new URLSearchParams("sort=pd"), keys)).toEqual({ key: "pd", dir: "asc" });
    expect(sortFromParams(new URLSearchParams("sort=DROP"), keys)).toBeNull();
    expect(sortFromParams(new URLSearchParams(""), keys)).toBeNull();
  });

  it("goes back to page 1 and keeps the filters", () => {
    const n = writeSortParams(new URLSearchParams("q=steel&page=4"), { key: "pd", dir: "desc" });
    expect(Object.fromEntries(n)).toEqual({ q: "steel", sort: "pd", order: "desc" });
    expect(Object.fromEntries(writeSortParams(n, null))).toEqual({ q: "steel" });
  });
});
