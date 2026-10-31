"""CREDORA.ANOMALY_FLAG and CREDORA.PD_SCORE (exasol/udf/05_ml_udfs.sql), run unchanged in
exasol/udf-mock-python's mock Exasol environment."""

from __future__ import annotations

import json
import pickle

import numpy as np
import pytest
from exasol_udf_mock_python.column import Column
from exasol_udf_mock_python.group import Group
from exasol_udf_mock_python.mock_exa_environment import MockExaEnvironment
from exasol_udf_mock_python.udf_mock_executor import UDFMockExecutor

from conftest import meta

ML = "exasol/udf/05_ml_udfs.sql"
FEATS = ["gst_years", "gst_turnover_12m", "gst_late_filings_12m", "gst_bank_gap_pct", "avg_balance_12m",
         "inflow_volatility", "bounce_ratio", "cmr_rank", "partner_min_score", "partner_avg_score",
         "partner_overdue_amt", "partner_other_bank_bal", "dscr"]


def companies(n=200, seed=3):
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        turnover = rng.uniform(5e7, 2e8)
        credits = turnover * rng.uniform(0.9, 1.1)
        rows.append([f"A{i:05d}", 3.0, turnover, credits, turnover * rng.uniform(0.05, 0.1),
                     rng.uniform(0.1, 0.3), rng.uniform(1e5, 1e6)])
    for i in (7, 70, 170):  # GST turnover ten times the bank credits: possible inflated turnover
        rows[i][3] = rows[i][2] / 10
    return rows


ANOMALY_IN = [Column("app_id", str, "VARCHAR(8)"), Column("contamination_pct", float, "DOUBLE"),
              Column("gst_turnover_12m", float, "DOUBLE"), Column("bank_credits_12m", float, "DOUBLE"),
              Column("avg_balance_12m", float, "DOUBLE"), Column("inflow_volatility", float, "DOUBLE"),
              Column("partner_other_bank_bal", float, "DOUBLE")]
ANOMALY_OUT = [Column("app_id", str, "VARCHAR(8)"), Column("score", float, "DOUBLE"),
               Column("is_anomaly", bool, "BOOLEAN"), Column("top_reasons", str, "VARCHAR(500)")]


def run_anomaly(rows):
    env = MockExaEnvironment(meta(ML, "CREDORA.ANOMALY_FLAG", ANOMALY_IN, ANOMALY_OUT))
    out = UDFMockExecutor().run([Group([tuple(r) for r in rows])], env)[0].rows
    return {r[0]: r for r in out}


def test_anomaly_flags_the_planted_companies_with_the_reason():
    out = run_anomaly(companies())
    assert len(out) == 200
    flagged = {k for k, r in out.items() if r[2]}
    assert {"A00007", "A00070", "A00170"} <= flagged
    assert len(flagged) <= 8  # about the 3% set by contamination_pct
    assert out["A00007"][3].startswith("GST turnover far above bank credits")
    assert out["A00007"][1] > np.median([r[1] for r in out.values()])


def test_anomaly_flags_nobody_at_zero_percent():
    rows = [[r[0], 0.0, *r[2:]] for r in companies()]
    assert not any(r[2] for r in run_anomaly(rows).values())


PD_IN = [Column("model_path", str, "VARCHAR(200)"), Column("app_id", str, "VARCHAR(8)")] + \
        [Column(f, float, "DOUBLE") for f in FEATS]
PD_OUT = [Column("app_id", str, "VARCHAR(8)"), Column("pd", float, "DOUBLE"), Column("contributions", str, "VARCHAR(20000)")]


@pytest.fixture
def model_file(tmp_path):
    from sklearn.linear_model import LogisticRegression

    rng = np.random.default_rng(1)
    X = rng.normal(size=(400, len(FEATS)))
    y = (X[:, 7] + rng.normal(scale=0.5, size=400) > 0.8).astype(int)  # cmr_rank drives default
    path = tmp_path / "model.pkl"
    path.write_bytes(pickle.dumps({"features": FEATS, "baseline": {f: 0.0 for f in FEATS},
                                   "model": LogisticRegression().fit(X, y)}))
    return str(path)


def test_pd_score_emits_a_probability_and_each_features_effect(model_file):
    rows = [(model_file, "A1", *([0.0] * 7), 3.0, *([0.0] * 5)),   # bad CIBIL commercial rank
            (model_file, "A2", *([0.0] * 7), -3.0, *([0.0] * 5)),  # good rank
            (model_file, "A3", *([0.0] * 7), None, *([0.0] * 5))]  # missing: the baseline is used
    env = MockExaEnvironment(meta(ML, "CREDORA.PD_SCORE", PD_IN, PD_OUT))
    out = {r[0]: r for r in UDFMockExecutor().run([Group(rows)], env)[0].rows}
    assert all(0 <= r[1] <= 1 for r in out.values())
    assert out["A1"][1] > out["A3"][1] > out["A2"][1]
    contrib = json.loads(out["A1"][2])
    assert set(contrib) == set(FEATS)
    assert contrib["cmr_rank"] > 0 and abs(contrib["gst_years"]) < 1e-9
    assert json.loads(out["A3"][2])["cmr_rank"] == 0  # at the baseline: no effect
