import datetime as dt
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app import exa
from app.excerpts import STEP_INFO, report_steps
from app.excerpts_code import CODE

LUA = Path(__file__).resolve().parents[2] / "exasol" / "lua" / "06_run_analysis.sql"


@pytest.mark.skipif(not LUA.exists(), reason="repo Exasol scripts not present")
def test_excerpts_are_faithful_to_the_exasol_scripts():
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    import sync_excerpts

    lua = LUA.read_text(encoding="utf-8")
    assert CODE == sync_excerpts.build(lua), "excerpts drifted from the Exasol scripts; run tools/sync_excerpts.py"
    flat = " ".join(lua.split())
    for n, (lang, code) in CODE.items():
        if lang == "lua":
            assert code in lua, f"step {n} Lua excerpt drifted; run tools/sync_excerpts.py"
        else:
            for stmt in code.split(";\n\n"):
                for part in stmt.rstrip(";").split("\nWITH cfg AS (", 1):  # step 11: INSERT + DECISION_LOGIC
                    assert " ".join(part.split()) in flat, f"step {n} SQL drifted; run tools/sync_excerpts.py"


def test_every_step_has_info_and_code():
    assert set(STEP_INFO) == set(CODE) == set(range(1, 14))


def test_decide_excerpt_shows_the_anomaly_referral_and_challenger_reuses_it():
    decide = CODE[11][1]
    assert decide.startswith("INSERT INTO CREDORA.DECISIONS") and "WITH cfg AS (" in decide
    assert "LEFT JOIN CREDORA.ANOMALY an" in decide and "WHEN ANOMALY IS NOT NULL THEN 'REFER'" in decide
    assert "';Anomaly: ' || ANOMALY" in decide
    assert "ANOMALY_FLAG" in CODE[10][1]
    assert CODE[13][0] == "lua" and "logic.decide('CREDORA.CHALLENGER_SCORES')" in CODE[13][1]


def test_report_steps_join_run_log():
    steps = report_steps([{"STEP_NO": 2, "STATUS": "OK", "ROWS_OUT": 1000, "MS": 312, "DETAIL": None},
                          {"STEP_NO": 11, "STATUS": "FAILED", "ROWS_OUT": 0, "MS": 8, "DETAIL": "division by zero"}])
    assert [s["n"] for s in steps] == list(range(1, 14))
    assert steps[1]["ms"] == 312 and "1,000 applications" in steps[1]["what"]
    assert steps[0]["ms"] is None and steps[0]["language"] == "lua"
    assert "failed: division by zero" in steps[10]["what"]
    assert "PREFERRING" in steps[11]["code"]
    assert steps[9]["object"] == "CREDORA.ANOMALY_FLAG" and steps[12]["object"] == "CREDORA.SCORE_CHALLENGER"


def test_to_json_and_time_zones(monkeypatch):
    monkeypatch.setattr(exa, "_db_tz", ZoneInfo("Europe/Berlin"))
    assert exa.to_json(Decimal("1300000")) == 1300000
    assert exa.to_json(Decimal("11.60")) == 11.6
    assert exa.to_json(dt.date(2026, 10, 5)) == "2026-10-05"
    assert exa.to_json(dt.datetime(2026, 10, 31, 1, 22, 37, 861000)) == "2026-10-31T00:22:37.861Z"
    assert exa._tz_name("EUROPE/BERLIN") == "Europe/Berlin"
    assert exa._tz_name("AMERICA/NEW_YORK") == "America/New_York"
    assert exa._tz_name("UTC") == "UTC"
