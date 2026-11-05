import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { num, pct, pctFromRatio, rupeesShort } from "../../lib/format";
import type { AskChart as Chart, ChartUnit } from "../../api/types";

// Legend and tooltip keep the order of the bars, not the alphabet: a null sorter, and one that ranks all alike.
const keepOrder = () => 0;

/** One figure in the chart's unit, the way the rest of the app writes it. */
export function formatValue(unit: ChartUnit, v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  if (unit === "inr") return rupeesShort(v);
  if (unit === "percent") return pct(v);
  if (unit === "ratio") return pctFromRatio(v);
  return num(v, Number.isInteger(v) ? 0 : 2);
}

/** The rows Recharts draws: one per category, with each series under its own key. */
export function toRows(chart: Chart): Record<string, string | number | null>[] {
  return chart.categories.map((category, i) => {
    const row: Record<string, string | number | null> = { category };
    chart.series.forEach((s, j) => {
      row[`s${j}`] = s.values[i];
    });
    return row;
  });
}

/** Share of the total, for the legend of a share chart. */
export function sharePct(values: (number | null)[], i: number): string {
  const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  return total ? `${(((values[i] ?? 0) / total) * 100).toFixed(1)}%` : "–";
}

const color = (i: number) => `var(--series-${i + 1})`;
const clipLabel = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TICK = { fill: "var(--muted)", fontSize: 12 };
const TOOLTIP = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink)", fontSize: 13 },
  itemStyle: { color: "var(--ink-2)" },
  labelStyle: { color: "var(--ink)", fontWeight: 600 },
  cursor: { fill: "var(--surface-2)" },
};
const legendText = (value: string) => <span className="ask-chart-legend">{value}</span>;

function Figure({ chart }: { chart: Chart }) {
  const rows = toRows(chart);
  const many = chart.series.length > 1;
  const value = (v: unknown) => formatValue(chart.unit, typeof v === "number" ? v : null);
  const tooltipValue = (v: unknown, name: unknown) => [value(v), String(name)] as [string, string];

  if (chart.kind === "share") {
    const values = chart.series[0].values;
    const slices = chart.categories.map((name, i) => ({ name, value: values[i] ?? 0 }));
    return (
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
            {slices.map((s, i) => (
              <Cell key={s.name} fill={color(i)} />
            ))}
          </Pie>
          <Tooltip {...TOOLTIP} itemSorter={keepOrder} formatter={tooltipValue} />
          <Legend itemSorter={null} layout="vertical" align="right" verticalAlign="middle" formatter={(name: string) => legendText(`${name} · ${sharePct(values, chart.categories.indexOf(name))}`)} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chart.kind === "line") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="category" tick={TICK} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={16} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} tickFormatter={value} width={72} />
          <Tooltip {...TOOLTIP} itemSorter={keepOrder} formatter={tooltipValue} cursor={{ stroke: "var(--muted)" }} />
          {many && <Legend formatter={legendText} itemSorter={null} />}
          {chart.series.map((s, i) => (
            <Line key={s.name} dataKey={`s${i}`} name={s.name} stroke={color(i)} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)", fill: color(i) }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Long names, such as companies, read better beside horizontal bars.
  const sideways = chart.categories.some((c) => c.length > 12);
  if (sideways) {
    const height = Math.max(220, chart.categories.length * (10 + chart.series.length * 18) + (many ? 60 : 30));
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} layout="vertical" barGap={2} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="var(--line)" />
          <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={value} />
          <YAxis type="category" dataKey="category" tick={TICK} tickLine={false} axisLine={{ stroke: "var(--line)" }} width={170} interval={0} tickFormatter={(c: string) => clipLabel(c, 24)} />
          <Tooltip {...TOOLTIP} itemSorter={keepOrder} formatter={tooltipValue} />
          {many && <Legend formatter={legendText} itemSorter={null} />}
          {chart.series.map((s, i) => (
            <Bar key={s.name} dataKey={`s${i}`} name={s.name} fill={color(i)} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={rows} barGap={2} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis dataKey="category" tick={TICK} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={8} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} tickFormatter={value} width={72} />
        <Tooltip {...TOOLTIP} itemSorter={keepOrder} formatter={tooltipValue} />
        {many && <Legend formatter={legendText} itemSorter={null} />}
        {chart.series.map((s, i) => (
          <Bar key={s.name} dataKey={`s${i}`} name={s.name} fill={color(i)} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartTable({ chart }: { chart: Chart }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">
              <code>{chart.x_label}</code>
            </th>
            {chart.series.map((s) => (
              <th key={s.name} scope="col" className="r">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.categories.map((c, i) => (
            <tr key={c}>
              <th scope="row">{c}</th>
              {chart.series.map((s) => (
                <td key={s.name} className="r num">
                  {formatValue(chart.unit, s.values[i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OneChart({ chart }: { chart: Chart }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="ask-chart">
      <figcaption className="ask-chart-head">
        <span className="ask-chart-title">{chart.title}</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsTable((t) => !t)}>
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </figcaption>
      {asTable ? (
        <ChartTable chart={chart} />
      ) : (
        <div role="img" aria-label={`${chart.title}. Open the table for the values.`}>
          <Figure chart={chart} />
        </div>
      )}
    </figure>
  );
}

/** Loaded on its own, so people who never see a chart do not download the chart library. */
export default function AskCharts({ charts }: { charts: Chart[] }) {
  return (
    <>
      {charts.map((chart, i) => (
        <OneChart key={`${i}-${chart.title}`} chart={chart} />
      ))}
    </>
  );
}
