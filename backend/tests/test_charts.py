import asyncio
import json
from types import SimpleNamespace as NS

import pytest

from app import assistant, charts
from app.charts import ChartError, build_chart

RESULT = json.dumps({
    "columns": ["GST_STAGE", "GRADE", "AVG_PD", "EXPECTED_LOSS"],
    "rows": [["New", "A1", "0.0044", 3510000], ["New", "A2", "0.0148", 4220000],
             ["Stable", "A1", "0.0044", 1910000], ["Stable", "A2", None, 2630000]],
})


def spec(**kw):
    return {"kind": "bar", "title": "Average PD", "x": "grade", "y": ["avg_pd"], "group": "gst_stage",
            "unit": "ratio", **kw}


def test_grouped_chart_reads_the_numbers_from_the_result():
    c = build_chart(spec(), RESULT)
    assert c["categories"] == ["A1", "A2"]
    assert c["series"] == [{"name": "New", "values": [0.0044, 0.0148]},
                           {"name": "Stable", "values": [0.0044, None]}]
    assert c["kind"] == "bar" and c["unit"] == "ratio" and c["x_label"] == "GRADE"


def test_several_y_columns_become_series_and_row_order_is_kept():
    r = json.dumps({"columns": ["MONTH", "A", "B"], "rows": [["2026-03", 3, 30], ["2026-01", 1, 10]]})
    c = build_chart({"kind": "line", "title": "t", "x": "MONTH", "y": ["A", "B"], "unit": "number"}, r)
    assert c["categories"] == ["2026-03", "2026-01"]
    assert c["series"] == [{"name": "A", "values": [3, 1]}, {"name": "B", "values": [30, 10]}]


@pytest.mark.parametrize("change, text, says", [
    ({"x": "NOPE"}, RESULT, "no single column"),
    ({"group": None}, RESULT, "more than once"),
    ({"y": ["GST_STAGE"]}, RESULT, "not numeric"),
    ({"y": ["AVG_PD", "EXPECTED_LOSS"]}, RESULT, "one y column"),
    ({"kind": "pie"}, RESULT, "kind must be"),
    ({"unit": "lakh"}, RESULT, "unit must be"),
    ({}, "not json", "no query result"),
    ({}, None, "no query result"),
    ({}, json.dumps({"columns": ["GRADE", "AVG_PD", "GST_STAGE"], "rows": []}), "no rows"),
])
def test_a_chart_it_cannot_draw_is_refused_with_a_reason(change, text, says):
    with pytest.raises(ChartError, match=says):
        build_chart(spec(**change), text)


def test_too_many_categories_series_or_share_parts_are_refused():
    many = json.dumps({"columns": ["X", "Y"], "rows": [[str(i), i + 1] for i in range(charts.MAX_CATEGORIES + 1)]})
    with pytest.raises(ChartError, match="Aggregate"):
        build_chart({"kind": "bar", "title": "t", "x": "X", "y": ["Y"], "unit": "number"}, many)
    groups = json.dumps({"columns": ["X", "G", "Y"], "rows": [["a", str(i), 1] for i in range(charts.MAX_SERIES + 1)]})
    with pytest.raises(ChartError, match="series"):
        build_chart({"kind": "bar", "title": "t", "x": "X", "y": ["Y"], "group": "G", "unit": "number"}, groups)
    slices = json.dumps({"columns": ["X", "Y"], "rows": [[str(i), 1] for i in range(charts.MAX_SHARE_SLICES + 1)]})
    with pytest.raises(ChartError, match="at most"):
        build_chart({"kind": "share", "title": "t", "x": "X", "y": ["Y"], "unit": "number"}, slices)


def test_share_needs_positive_values():
    r = json.dumps({"columns": ["X", "Y"], "rows": [["a", 5], ["b", -1]]})
    with pytest.raises(ChartError, match="positive"):
        build_chart({"kind": "share", "title": "t", "x": "X", "y": ["Y"], "unit": "number"}, r)
    r = json.dumps({"columns": ["X", "Y"], "rows": [["a", 5], ["b", 1]]})
    assert build_chart({"kind": "share", "title": "t", "x": "X", "y": ["Y"], "unit": "number"}, r)["kind"] == "share"


class Session:
    async def call_tool(self, name, args):
        return NS(content=[NS(type="text", text=RESULT)], structuredContent=None, isError=False)


class Client:
    """Queries, charts in the next turn, then answers."""

    def __init__(self, chart_input):
        self.messages = self
        self.turn = 0
        self.chart_input = chart_input
        self.sent = []

    def create(self, **kw):
        self.turn += 1
        self.sent = kw["messages"]
        if self.turn == 1:
            return NS(stop_reason="tool_use", content=[
                NS(type="tool_use", id="q", name="execute_exasol_query", input={"query": "SELECT 1"})])
        if self.turn == 2:
            return NS(stop_reason="tool_use", content=[
                NS(type="tool_use", id="c", name=charts.TOOL_NAME, input=self.chart_input)])
        return NS(stop_reason="end_turn", content=[NS(type="text", text="Done.")])


def _run(client):
    steps, found = [], []
    answer = asyncio.run(assistant._loop(client, Session(), "sys", [], [{"role": "user", "content": "q"}],
                                         steps, charts=found))
    return answer, steps, found


def test_the_loop_draws_a_chart_from_the_last_query_without_counting_it_as_an_mcp_call():
    client = Client(spec())
    answer, steps, found = _run(client)
    assert answer == "Done."
    assert [s["tool"] for s in steps] == ["execute_exasol_query"]
    assert found[0]["series"][0]["values"] == [0.0044, 0.0148]
    last = client.sent[-1]["content"][0]
    assert last["tool_use_id"] == "c" and last["is_error"] is False


def test_the_loop_tells_the_model_why_a_chart_failed():
    client = Client(spec(x="NOPE"))
    _, _, found = _run(client)
    assert found == []
    last = client.sent[-1]["content"][0]
    assert last["is_error"] is True and "no single column" in last["content"]
