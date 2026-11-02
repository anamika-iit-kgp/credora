"""Model-validation evidence: the calibration and PSI payloads, the endpoints and who may call them."""

import json

import pytest
from fastapi.testclient import TestClient

from app import crm, exa, runs, validation
from app.auth import issue_token, make_user
from app.main import app
from app.validation import calibration_view, psi_band, psi_view

c = TestClient(app)


def h(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


def cal_row(decile, n=125, defaults=None, mean_pd=None, auc=0.7561, registry_auc=0.7561):
    mean_pd = mean_pd if mean_pd is not None else 0.01 * decile
    return {"DECILE": decile, "N": n, "DEFAULTS": defaults if defaults is not None else round(n * mean_pd),
            "MEAN_PD": mean_pd, "OBSERVED_RATE": (defaults if defaults is not None else round(n * mean_pd)) / n,
            "PD_MIN": mean_pd - 0.004, "PD_MAX": mean_pd + 0.004, "N_HOLDOUT": 1250, "BRIER": 0.0612,
            "BRIER_BASE": 0.0694, "AUC": auc, "REGISTRY_AUC": registry_auc, "COMPUTED_AT": "2026-11-02T08:00:00.000Z"}


def psi_row(feature, psi, bins=None):
    bins = bins or [{"bin": b, "hi": None if b == 10 else b * 10.0, "train": 0.1, "live": 0.1} for b in range(1, 11)]
    return {"FEATURE": feature, "PSI": psi, "N_TRAIN": 5000, "N_LIVE": 1000, "NULL_LIVE": 3, "TRAIN_MEAN": 4.2,
            "LIVE_MEAN": 4.4, "BINS": json.dumps(bins), "COMPUTED_AT": "2026-11-02T08:05:00.000Z"}


# ---------------------------------------------------------------- pure views

def test_psi_bands_follow_the_usual_thresholds():
    assert psi_band(None) == "unknown"
    assert psi_band(0.0) == "stable" and psi_band(0.0999) == "stable"
    assert psi_band(0.1) == "shift" and psi_band(0.25) == "shift"
    assert psi_band(0.2501) == "significant" and psi_band(1.7) == "significant"


def test_calibration_view_orders_deciles_and_checks_the_registry_auc():
    rows = [cal_row(d) for d in (3, 1, 2, 4, 5, 6, 7, 8, 9, 10)]
    v = calibration_view("v3", rows)
    assert v["computed"] and v["version"] == "v3" and v["n_holdout"] == 1250
    assert [d["decile"] for d in v["deciles"]] == list(range(1, 11))
    assert v["brier"] == 0.0612 and v["brier_base"] == 0.0694 and v["auc"] == 0.7561
    assert v["reproduces_training"] is True
    assert v["max_gap"] == pytest.approx(max(abs(d["mean_pd"] - d["observed_rate"]) for d in v["deciles"]))
    off = calibration_view("v3", [cal_row(d, auc=0.7561, registry_auc=0.7420) for d in range(1, 11)])
    assert off["reproduces_training"] is False, "the past loans changed since the training"


def test_calibration_view_without_rows_is_not_computed():
    v = calibration_view("v9", [])
    assert v == {"version": "v9", "computed": False, "computed_at": None, "n_holdout": 0, "brier": None,
                 "brier_base": None, "auc": None, "registry_auc": None, "reproduces_training": False,
                 "max_gap": None, "deciles": []}


def test_psi_view_sorts_largest_shift_first_and_counts_bands():
    v = psi_view("R1", [psi_row("cmr_rank", 0.02), psi_row("avg_balance_12m", 0.41), psi_row("dscr", 0.13)])
    assert v["computed"] and v["run_id"] == "R1"
    assert [f["feature"] for f in v["features"]] == ["avg_balance_12m", "dscr", "cmr_rank"]
    assert v["max_feature"] == "avg_balance_12m" and v["max_psi"] == 0.41 and v["band"] == "significant"
    assert v["counts"] == {"stable": 1, "shift": 1, "significant": 1}
    assert v["thresholds"] == {"some_shift": 0.1, "significant": 0.25}
    f = v["features"][0]
    assert f["null_live"] == 3 and len(f["bins"]) == 10 and f["bins"][9]["hi"] is None and f["bins"][0]["hi"] == 10.0


def test_psi_view_without_rows_or_run():
    assert psi_view(None, []) == {"run_id": None, "computed": False, "computed_at": None, "max_psi": None,
                                  "max_feature": None, "band": "unknown",
                                  "counts": {"stable": 0, "shift": 0, "significant": 0},
                                  "thresholds": {"some_shift": 0.1, "significant": 0.25}, "features": []}
    assert psi_view("R2", [{"FEATURE": "dscr", "PSI": 0.05, "BINS": "not json"}])["features"][0]["bins"] == []


# ---------------------------------------------------------------- endpoints

@pytest.fixture
def fake_exasol(monkeypatch):
    """exa.query stand-in: records (user, sql) and answers the validation reads."""
    seen = []

    def query(user, sql, params=None):
        seen.append((user, sql, params or {}))
        if "FROM CREDORA.MODEL_CALIBRATION WHERE MODEL_VERSION" in sql and "MAX(" not in sql:
            return [cal_row(d) for d in range(1, 11)] if params.get("v") == "v3" else []
        if "FROM CREDORA.MODEL_PSI WHERE RUN_ID" in sql:
            return [psi_row("dscr", 0.31), psi_row("cmr_rank", 0.01)] if params.get("r") == "R1" else []
        if "FROM CREDORA.MODEL_REGISTRY WHERE MODEL_VERSION" in sql:
            return [{"MODEL_VERSION": "v3"}] if params.get("v") == "v3" else []
        return []

    monkeypatch.setattr(exa, "query", query)
    monkeypatch.setattr(crm, "audit", lambda *a, **k: None)
    monkeypatch.setattr(runs, "current_run", lambda user_db: {"run_id": "R1"})
    return seen


def test_calibration_is_read_as_the_callers_user(fake_exasol):
    for role in ("loanops", "rm"):
        assert c.get("/api/ml/models/v3/calibration", headers=h(role)).status_code == 403
    r = c.get("/api/ml/models/v3/calibration", headers=h("admin"))
    assert r.status_code == 200
    body = r.json()
    assert body["computed"] and body["reproduces_training"] and len(body["deciles"]) == 10
    assert fake_exasol[-1][0] == "CREDORA_ADMIN"
    assert c.get("/api/ml/models/v9/calibration", headers=h("datasci")).json()["computed"] is False


def test_calibrate_runs_the_script_as_the_service_account(fake_exasol):
    assert c.post("/api/ml/models/v3/calibration", headers=h("loanops")).status_code == 403
    assert c.post("/api/ml/models/v9/calibration", headers=h("datasci")).status_code == 404
    r = c.post("/api/ml/models/v3/calibration", headers=h("datasci"))
    assert r.status_code == 200 and r.json()["computed"]
    scripts = [(u, p) for u, s, p in fake_exasol if "EXECUTE SCRIPT CREDORA.CALIBRATE_MODEL" in s]
    assert scripts == [("CREDORA_SVC", {"v": "v3"})]
    assert fake_exasol[-1][0] == "CREDORA_DATASCI", "the fresh rows are read back as the caller"


def test_psi_defaults_to_the_current_run(fake_exasol):
    assert c.get("/api/ml/psi", headers=h("rm")).status_code == 403
    r = c.get("/api/ml/psi", headers=h("datasci"))
    assert r.status_code == 200
    body = r.json()
    assert body["run_id"] == "R1" and body["computed"] and body["max_feature"] == "dscr" and body["band"] == "significant"
    assert c.get("/api/ml/psi?run_id=R7", headers=h("admin")).json() == dict(psi_view("R7", []))


def test_psi_without_any_run(fake_exasol, monkeypatch):
    monkeypatch.setattr(runs, "current_run", lambda user_db: None)
    assert c.get("/api/ml/psi", headers=h("admin")).json()["computed"] is False
    assert c.post("/api/ml/psi", headers=h("datasci")).status_code == 404


def test_compute_psi_runs_the_script_for_the_asked_run(fake_exasol):
    r = c.post("/api/ml/psi", json={"run_id": "R1"}, headers=h("admin"))
    assert r.status_code == 200 and r.json()["computed"]
    assert [(u, p) for u, s, p in fake_exasol if "EXECUTE SCRIPT CREDORA.MODEL_PSI" in s] == [("CREDORA_SVC", {"r": "R1"})]
    r = c.post("/api/ml/psi", headers=h("datasci"))  # no body: the current run
    assert r.status_code == 200 and r.json()["run_id"] == "R1"


def test_training_steps_end_with_the_calibration():
    from app.jobs import TRAIN_STEPS
    assert TRAIN_STEPS[-1] == "Calibrate both on the hold-out (CREDORA.CALIBRATE_MODEL)" and len(TRAIN_STEPS) == 6
    assert validation.FEATURES[0] == "gst_years" and len(validation.FEATURES) == 13
