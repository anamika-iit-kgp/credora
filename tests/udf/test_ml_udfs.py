"""CREDORA.ANOMALY_FLAG, CREDORA.PD_SCORE, the two trainers, CREDORA.PD_CALIBRATE and CREDORA.MODEL_FILE_SHA256
(exasol/udf/05_ml_udfs.sql), run unchanged in exasol/udf-mock-python's mock Exasol environment."""

from __future__ import annotations

import hashlib
import json
import numbers
import pickle

import numpy as np
import pytest
import requests
from exasol_udf_mock_python.column import Column
from exasol_udf_mock_python.connection import Connection
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


PD_IN = [Column("model_path", str, "VARCHAR(200)"), Column("model_sha256", str, "VARCHAR(64)"),
         Column("app_id", str, "VARCHAR(8)")] + [Column(f, float, "DOUBLE") for f in FEATS]
PD_OUT = [Column("app_id", str, "VARCHAR(8)"), Column("pd", float, "DOUBLE"), Column("contributions", str, "VARCHAR(20000)")]


def file_sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def run_pd_score(rows):
    env = MockExaEnvironment(meta(ML, "CREDORA.PD_SCORE", PD_IN, PD_OUT))
    return {r[0]: r for r in UDFMockExecutor().run([Group(rows)], env)[0].rows}


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
    sha = file_sha256(model_file)
    rows = [(model_file, sha, "A1", *([0.0] * 7), 3.0, *([0.0] * 5)),   # bad CIBIL commercial rank
            (model_file, sha, "A2", *([0.0] * 7), -3.0, *([0.0] * 5)),  # good rank
            (model_file, sha, "A3", *([0.0] * 7), None, *([0.0] * 5))]  # missing: the baseline is used
    out = run_pd_score(rows)
    assert all(0 <= r[1] <= 1 for r in out.values())
    assert out["A1"][1] > out["A3"][1] > out["A2"][1]
    contrib = json.loads(out["A1"][2])
    assert set(contrib) == set(FEATS)
    assert contrib["cmr_rank"] > 0 and abs(contrib["gst_years"]) < 1e-9
    assert json.loads(out["A3"][2])["cmr_rank"] == 0  # at the baseline: no effect


def test_pd_score_refuses_a_model_file_whose_hash_differs_from_the_registry(model_file):
    rows = [(model_file, "0" * 64, "A1", *([0.0] * 13))]
    with pytest.raises(RuntimeError, match=r"does not match MODEL_REGISTRY\.MODEL_SHA256 \(expected 0{64}, found [0-9a-f]{64}\)"):
        run_pd_score(rows)


def test_pd_score_loads_a_row_registered_without_a_hash(model_file):
    out = run_pd_score([(model_file, None, "A1", *([0.0] * 13))])
    assert 0 <= out["A1"][1] <= 1


# --- the trainers: the hash they emit is the SHA-256 of the pickle they uploaded -------------------

TRAIN_IN = [Column("model_version", str, "VARCHAR(20)"), Column("loan_id", str, "VARCHAR(10)")] +            [Column(f, float, "DOUBLE") for f in FEATS] + [Column("defaulted", bool, "BOOLEAN")]
TRAIN_OUT = [Column("model_version", str, "VARCHAR(20)"), Column("algorithm", str, "VARCHAR(80)"),
             Column("auc", float, "DOUBLE"), Column("gini", float, "DOUBLE"), Column("n_train", numbers.Real, "DOUBLE"),
             Column("default_rate", float, "DOUBLE"), Column("feature_importance", str, "VARCHAR(20000)"),
             Column("model_path", str, "VARCHAR(200)"), Column("model_sha256", str, "VARCHAR(64)")]


def past_loans(n=400, seed=5):
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        x = rng.normal(size=len(FEATS))
        defaulted = bool(x[7] + rng.normal(scale=0.5) > 0.8)  # cmr_rank drives default
        rows.append(("v9", f"L{i:05d}", *[float(v) for v in x], defaulted))
    return rows


@pytest.fixture
def bucketfs(monkeypatch):
    """Capture what the trainer PUTs to BucketFS instead of sending it anywhere."""
    uploads = {}

    class Reply:
        status_code = 200

        def raise_for_status(self):
            pass

    def put(url, data=None, **kwargs):
        uploads[url] = bytes(data)
        return Reply()

    monkeypatch.setattr(requests, "put", put)
    return uploads


@pytest.mark.parametrize("script", ["CREDORA.TRAIN_PD", "CREDORA.TRAIN_SCORECARD"])
def test_trainer_emits_the_sha256_of_the_uploaded_pickle(script, bucketfs):
    env = MockExaEnvironment(meta(ML, script, TRAIN_IN, TRAIN_OUT),
                             connections={"BUCKETFS_MODELS": Connection("http://bucketfs/default/models", "w", "pw")})
    (row,) = UDFMockExecutor().run([Group(past_loans())], env)[0].rows
    assert row[0] == "v9" and row[7] == "/buckets/bfsdefault/default/models/pd_v9.pkl"
    assert bucketfs == {"http://bucketfs/default/models/pd_v9.pkl": bucketfs["http://bucketfs/default/models/pd_v9.pkl"]}
    data = bucketfs["http://bucketfs/default/models/pd_v9.pkl"]
    assert len(row[8]) == 64 and int(row[8], 16) >= 0  # 64 hex characters
    assert row[8] == hashlib.sha256(data).hexdigest()
    bundle = pickle.loads(data)
    assert bundle["version"] == "v9" and bundle["features"] == FEATS
    assert 0.5 < row[2] <= 1  # AUC on the hold-out


# --- MODEL_FILE_SHA256: the backfill for rows registered before the hash existed -------------------

def test_model_file_sha256_hashes_the_file_and_is_null_for_a_missing_one(model_file, tmp_path):
    env = MockExaEnvironment(meta(ML, "CREDORA.MODEL_FILE_SHA256", [Column("model_path", str, "VARCHAR(200)")],
                                  [Column("sha256", str, "VARCHAR(64)")], input_type="SCALAR", output_type="RETURNS"))
    out = UDFMockExecutor().run([Group([(model_file,), (str(tmp_path / "gone.pkl"),), (None,)])], env)[0].rows
    assert out == [(file_sha256(model_file),), (None,), (None,)]


# --- PD_CALIBRATE: calibration deciles, Brier and AUC on the trainers' own hold-out ----------------

CAL_IN = [Column("model_path", str, "VARCHAR(200)"), Column("model_sha256", str, "VARCHAR(64)"),
          Column("loan_id", str, "VARCHAR(10)")] + [Column(f, float, "DOUBLE") for f in FEATS] +          [Column("defaulted", bool, "BOOLEAN")]
CAL_OUT = [Column(c, float, "DOUBLE") for c in ("decile", "n", "defaults", "mean_pd", "observed_rate", "pd_min", "pd_max",
                                               "n_holdout", "brier", "brier_base", "auc")]


def run_calibrate(model_path, sha, loans):
    env = MockExaEnvironment(meta(ML, "CREDORA.PD_CALIBRATE", CAL_IN, CAL_OUT))
    rows = [(model_path, sha, loan_id, *feats, defaulted) for _, loan_id, *feats, defaulted in loans]
    return UDFMockExecutor().run([Group(rows)], env)[0].rows


def test_calibrate_reproduces_the_trainers_holdout_auc_and_emits_ten_deciles(bucketfs, tmp_path):
    # Train the scorecard as TRAIN_MODEL does, keep the pickle it uploaded, then calibrate that file.
    env = MockExaEnvironment(meta(ML, "CREDORA.TRAIN_SCORECARD", TRAIN_IN, TRAIN_OUT),
                             connections={"BUCKETFS_MODELS": Connection("http://bucketfs/default/models", "w", "pw")})
    loans = past_loans()
    (trained,) = UDFMockExecutor().run([Group(loans)], env)[0].rows
    path = tmp_path / "pd_v9.pkl"
    path.write_bytes(bucketfs["http://bucketfs/default/models/pd_v9.pkl"])

    out = run_calibrate(str(path), trained[8], list(reversed(loans)))  # input order must not matter
    assert [r[0] for r in out] == list(range(1, 11))
    assert sum(r[1] for r in out) == 100 and all(r[7] == 100 for r in out)  # the 25% hold-out of 400 loans
    assert out[0][10] == pytest.approx(trained[2]), "the same hold-out and recipe as the trainer measured"
    assert all(r[8] == out[0][8] and r[9] == out[0][9] and r[10] == out[0][10] for r in out)
    mean_pd = [r[3] for r in out]
    assert mean_pd == sorted(mean_pd) and all(r[5] <= r[3] <= r[6] for r in out)
    assert out[-1][4] > out[0][4], "more defaults in the top PD decile than in the bottom one"
    assert sum(r[2] for r in out) == sum(r[1] * r[4] for r in out)
    assert 0 < out[0][8] < out[0][9] < 0.25, "the model beats always predicting the training default rate"


def test_calibrate_refuses_a_model_file_whose_hash_differs(model_file):
    with pytest.raises(RuntimeError, match=r"does not match MODEL_REGISTRY\.MODEL_SHA256"):
        run_calibrate(model_file, "0" * 64, past_loans(n=80))
