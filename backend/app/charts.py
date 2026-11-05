"""Charts in Ask Credora answers.

The model chooses the chart and names the columns. The numbers come only from the result of the query
it just ran, so a chart cannot show a figure Exasol did not return.
"""

from __future__ import annotations

import json
import math
from typing import Any

TOOL_NAME = "show_chart"
MAX_CHARTS = 3
MAX_CATEGORIES = 40
MAX_SERIES = 8
MAX_SHARE_SLICES = 6

TOOL = {
    "name": TOOL_NAME,
    "description": (
        "Show a chart under the answer, drawn from the result of the query you ran last. You name the columns. "
        "The numbers are read from that result, so run the query first. Use it when a comparison across 3 or more "
        "categories, or a change over time, is easier to see than to read. Do not use it for one or two numbers. "
        "Each chart has one axis, so measures with different units need separate charts."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["bar", "line", "share"],
                     "description": "bar to compare categories, line for change over time, share for parts of a "
                                    f"whole with at most {MAX_SHARE_SLICES} parts"},
            "title": {"type": "string", "description": "What the chart shows, in plain words"},
            "x": {"type": "string", "description": "Column for the categories or dates"},
            "y": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                  "description": "Numeric column or columns to plot, all in the same unit"},
            "group": {"type": "string", "description": "Optional column whose values become the separate series. "
                                                       "Use it with one y column"},
            "unit": {"type": "string", "enum": ["inr", "percent", "ratio", "number"],
                     "description": "inr for rupees, percent for values already in %, ratio for 0 to 1 values shown "
                                    "as %, number for counts and anything else"},
        },
        "required": ["kind", "title", "x", "y", "unit"],
    },
}

PROMPT = """

CHARTS: when the answer compares 3 or more categories or shows change over time, run the query, then call \
show_chart with the columns to plot. Measures with different units, such as a percentage and an amount, go in \
separate charts. After a chart, keep the text short: lead with the finding and do not list every value, because \
the reader sees the chart and can open its table."""


class ChartError(ValueError):
    """The chart cannot be drawn. The message goes back to the model so it can correct the call."""


def parse_result(text: str) -> tuple[list[str], list[list[Any]]] | None:
    """The columns and rows of a query result, or None when the text is not one."""
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    columns, rows = data.get("columns"), data.get("rows")
    if not isinstance(columns, list) or not isinstance(rows, list):
        return None
    if not all(isinstance(c, str) for c in columns) or not all(isinstance(r, list) for r in rows):
        return None
    return columns, rows


def _number(value: Any, column: str) -> float | None:
    """Exasol sends large decimals as text, so numeric text counts as a number. NULL stays a gap."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ChartError(f"Column {column} is not numeric.")
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise ChartError(f"Column {column} is not numeric.") from None
    if not math.isfinite(out):
        raise ChartError(f"Column {column} is not numeric.")
    return out


def _index(columns: list[str], name: Any) -> int:
    """Exasol upper-cases unquoted names, so the model's spelling is matched without regard to case."""
    matches = [i for i, c in enumerate(columns) if isinstance(name, str) and c.upper() == name.upper()]
    if len(matches) != 1:
        raise ChartError(f"The last query has no single column {name}. Its columns are {', '.join(columns)}.")
    return matches[0]


def build_chart(spec: dict, result_text: str | None) -> dict:
    """Pure: the model's chart request and the last query result -> what the screen draws."""
    parsed = parse_result(result_text) if result_text else None
    if parsed is None:
        raise ChartError("There is no query result to chart. Run a query first.")
    columns, rows = parsed
    if not rows:
        raise ChartError("The last query returned no rows, so there is nothing to chart.")

    kind, unit = spec.get("kind"), spec.get("unit")
    if kind not in ("bar", "line", "share"):
        raise ChartError("kind must be bar, line or share.")
    if unit not in ("inr", "percent", "ratio", "number"):
        raise ChartError("unit must be inr, percent, ratio or number.")
    y_names = spec.get("y")
    if not isinstance(y_names, list) or not y_names:
        raise ChartError("y must name at least one column.")
    x = _index(columns, spec.get("x"))
    ys = [_index(columns, name) for name in y_names]
    group = _index(columns, spec["group"]) if spec.get("group") else None
    if group is not None and len(ys) != 1:
        raise ChartError("Use one y column with group.")

    categories: list[str] = []
    for row in rows:
        c = str(row[x])
        if c not in categories:
            categories.append(c)
    if len(categories) > MAX_CATEGORIES:
        raise ChartError(f"That is {len(categories)} categories. Aggregate to at most {MAX_CATEGORIES}.")
    position = {c: i for i, c in enumerate(categories)}

    series: dict[str, list[float | None]] = {}
    filled: set[tuple[str, str]] = set()

    def put(name: str, category: str, value: float | None) -> None:
        if (name, category) in filled:
            raise ChartError(f"{category} appears more than once. Aggregate the query or add a group column.")
        filled.add((name, category))
        series.setdefault(name, [None] * len(categories))[position[category]] = value

    for row in rows:
        if len(row) != len(columns):
            raise ChartError("The last query's rows do not match its columns.")
        category = str(row[x])
        if group is not None:
            put(str(row[group]), category, _number(row[ys[0]], columns[ys[0]]))
        else:
            for i in ys:
                put(columns[i], category, _number(row[i], columns[i]))

    if len(series) > MAX_SERIES:
        raise ChartError(f"That is {len(series)} series. Use at most {MAX_SERIES}, or split it into separate charts.")
    if kind == "share":
        if len(series) != 1:
            raise ChartError("A share chart has one y column and no group.")
        values = next(iter(series.values()))
        if len(categories) > MAX_SHARE_SLICES:
            raise ChartError(f"A share chart has at most {MAX_SHARE_SLICES} parts. Use a bar chart.")
        if any(v is None or v < 0 for v in values) or not sum(v or 0 for v in values):
            raise ChartError("A share chart needs positive values. Use a bar chart.")

    return {
        "kind": kind,
        "title": str(spec.get("title") or "")[:160],
        "unit": unit,
        "x_label": columns[x],
        "categories": categories,
        "series": [{"name": name, "values": values} for name, values in series.items()],
    }
