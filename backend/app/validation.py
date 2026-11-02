"""Model-validation evidence, read for the Models screen and computed on request.

Two tables in Exasol hold it. CREDORA.MODEL_CALIBRATION is the calibration of one registered model on
the training's own hold-out, one row per decile of predicted PD (written by CREDORA.CALIBRATE_MODEL
through the Python UDF PD_CALIBRATE). CREDORA.MODEL_PSI is the population stability index of one
run's live features against the past loans the models learnt from (written by CREDORA.MODEL_PSI).
Both scripts run as CREDORA_SVC. This module triggers them and shapes what they wrote. The reading
of the figures, and the known gap between past loans and live features, are in
docs/MODEL_VALIDATION.md.
"""

from __future__ import annotations

import json
from typing import Any

from . import console, exa

# The usual PSI reading. Below 0.1 stable, 0.1 to 0.25 some shift, above 0.25 a significant shift.
PSI_SOME_SHIFT = 0.1
PSI_SIGNIFICANT = 0.25
# A reproduced hold-out AUC within this of the registry's means the past loans are the training's.
AUC_TOLERANCE = 0.0005

FEATURES = ["gst_years", "gst_turnover_12m", "gst_late_filings_12m", "gst_bank_gap_pct", "avg_balance_12m",
            "inflow_volatility", "bounce_ratio", "cmr_rank", "partner_min_score", "partner_avg_score",
            "partner_overdue_amt", "partner_other_bank_bal", "dscr"]


def psi_band(psi: float | None) -> str:
    """Pure: 'stable', 'shift', 'significant', or 'unknown' when there is no value."""
    if psi is None:
        return "unknown"
    if psi < PSI_SOME_SHIFT:
        return "stable"
    if psi <= PSI_SIGNIFICANT:
        return "shift"
    return "significant"


def _f(v: Any) -> float | None:
    return None if v is None else float(v)


def _i(v: Any) -> int:
    return int(v or 0)


def calibration_view(version: str, rows: list[dict]) -> dict[str, Any]:
    """Pure: MODEL_CALIBRATION rows of one model (upper-case keys) -> the calibration payload.
    `computed` is false when the model has no rows yet."""
    rows = sorted(rows, key=lambda r: int(r["DECILE"]))
    if not rows:
        return {"version": version, "computed": False, "computed_at": None, "n_holdout": 0, "brier": None,
                "brier_base": None, "auc": None, "registry_auc": None, "reproduces_training": False,
                "max_gap": None, "deciles": []}
    first = rows[0]
    auc, reg = _f(first.get("AUC")), _f(first.get("REGISTRY_AUC"))
    deciles = [{"decile": int(r["DECILE"]), "n": _i(r["N"]), "defaults": _i(r["DEFAULTS"]),
                "mean_pd": _f(r["MEAN_PD"]), "observed_rate": _f(r["OBSERVED_RATE"]),
                "pd_min": _f(r["PD_MIN"]), "pd_max": _f(r["PD_MAX"])} for r in rows]
    gaps = [abs((d["mean_pd"] or 0) - (d["observed_rate"] or 0)) for d in deciles]
    return {"version": version, "computed": True, "computed_at": first.get("COMPUTED_AT"),
            "n_holdout": _i(first.get("N_HOLDOUT")), "brier": _f(first.get("BRIER")),
            "brier_base": _f(first.get("BRIER_BASE")), "auc": auc, "registry_auc": reg,
            "reproduces_training": auc is not None and reg is not None and abs(auc - reg) <= AUC_TOLERANCE,
            "max_gap": max(gaps) if gaps else None, "deciles": deciles}


def _bins(raw: Any) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [{"bin": int(b.get("bin", i + 1)), "hi": _f(b.get("hi")), "train": float(b.get("train") or 0),
             "live": float(b.get("live") or 0)} for i, b in enumerate(items)]


def psi_view(run_id: str | None, rows: list[dict]) -> dict[str, Any]:
    """Pure: MODEL_PSI rows of one run (upper-case keys) -> the PSI payload, largest shift first."""
    feats = [{"feature": r["FEATURE"], "psi": _f(r["PSI"]), "band": psi_band(_f(r["PSI"])),
              "n_train": _i(r.get("N_TRAIN")), "n_live": _i(r.get("N_LIVE")), "null_live": _i(r.get("NULL_LIVE")),
              "train_mean": _f(r.get("TRAIN_MEAN")), "live_mean": _f(r.get("LIVE_MEAN")),
              "bins": _bins(r.get("BINS"))} for r in rows]
    feats.sort(key=lambda f: -(f["psi"] if f["psi"] is not None else -1))
    counts = {"stable": 0, "shift": 0, "significant": 0}
    for f in feats:
        if f["band"] in counts:
            counts[f["band"]] += 1
    top = feats[0] if feats else None
    return {"run_id": run_id, "computed": bool(feats),
            "computed_at": rows[0].get("COMPUTED_AT") if rows else None,
            "max_psi": top["psi"] if top else None, "max_feature": top["feature"] if top else None,
            "band": top["band"] if top else "unknown", "counts": counts,
            "thresholds": {"some_shift": PSI_SOME_SHIFT, "significant": PSI_SIGNIFICANT}, "features": feats}


# ---------------------------------------------------------------- compute, as the service account

def compute_calibration(version: str) -> None:
    """EXECUTE SCRIPT CREDORA.CALIBRATE_MODEL(version) as CREDORA_SVC. Replaces the model's rows."""
    exa.query(exa.SVC, "EXECUTE SCRIPT CREDORA.CALIBRATE_MODEL({v})", {"v": version})
    console.event(f"CREDORA.MODEL_CALIBRATION holds {version}. PD_CALIBRATE repeated the trainers' hold-out split "
                  "over VS_LOS.past_loan_training and scored it with a fresh copy of the model's recipe",
                  exa_user=exa.SVC, objects=["CREDORA.CALIBRATE_MODEL", "CREDORA.PD_CALIBRATE", "CREDORA.MODEL_CALIBRATION"])


def compute_psi(run_id: str) -> None:
    """EXECUTE SCRIPT CREDORA.COMPUTE_PSI(run_id) as CREDORA_SVC. Replaces the run's rows."""
    exa.query(exa.SVC, "EXECUTE SCRIPT CREDORA.COMPUTE_PSI({r})", {"r": run_id})
    console.event(f"CREDORA.MODEL_PSI holds run {run_id}. Each of the 13 features of CREDORA.FEATURES was binned "
                  "against the tenths of VS_LOS.past_loan_training", exa_user=exa.SVC,
                  objects=["CREDORA.MODEL_PSI", "CREDORA.FEATURES", "VS_LOS"])
