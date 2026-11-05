import { describe, expect, it } from "vitest";
import type { AskChart } from "../../api/types";
import { formatValue, sharePct, toRows } from "./AskChart";

const chart: AskChart = {
  kind: "bar",
  title: "Average PD",
  unit: "ratio",
  x_label: "GRADE",
  categories: ["A1", "A2"],
  series: [
    { name: "New", values: [0.0044, 0.0148] },
    { name: "Stable", values: [0.0044, null] },
  ],
};

describe("Ask Credora charts", () => {
  it("has one row per category and keeps a missing value as a gap", () => {
    expect(toRows(chart)).toEqual([
      { category: "A1", s0: 0.0044, s1: 0.0044 },
      { category: "A2", s0: 0.0148, s1: null },
    ]);
  });

  it("writes values in the chart's unit", () => {
    expect(formatValue("ratio", 0.0148)).toBe("1.48%");
    expect(formatValue("percent", 10.5)).toBe("10.50%");
    expect(formatValue("inr", 34560000)).toContain("3.46");
    expect(formatValue("number", 42)).toBe("42");
    expect(formatValue("number", null)).toBe("–");
  });

  it("works out each part's share of the total", () => {
    expect(sharePct([25, 75], 0)).toBe("25.0%");
    expect(sharePct([0, 0], 0)).toBe("–");
  });
});
