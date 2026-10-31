"""Champion/challenger: which model is which, and the comparison the Models screen shows.

Both models are trained by CREDORA.TRAIN_MODEL on the same past loans and measured on the same
hold-out. CREDORA.SCORE_CHALLENGER scores each run with the challenger, shadow only, and stores the
decision it would have given in CREDORA.CHALLENGER_SCORES. This module only reads those results.
"""

from __future__ import annotations

import json
from typing import Any

SCORECARD = "LogisticRegression scorecard"


def is_scorecard(algorithm: str | None) -> bool:
    return (algorithm or "").startswith("LogisticRegression")


def importance_list(raw: str | None, algorithm: str | None = None) -> list[dict]:
    """FEATURE_IMPORTANCE JSON -> [{feature, importance}], biggest effect first. For the scorecard
    the values are signed coefficients (log-odds per standard deviation), ordered by size."""
    if not raw:
        return []
    d = json.loads(raw)
    items = [{"feature": k, "importance": round(float(v), 5)} for k, v in d.items()]
    key = (lambda x: -abs(x["importance"])) if is_scorecard(algorithm) else (lambda x: -x["importance"])
    return sorted(items, key=key)


def pick_challenger(models: list[dict], champion: dict | None) -> dict | None:
    """The newest model of another algorithm than the champion, as CREDORA.SCORE_CHALLENGER picks it.
    `models` are MODEL_REGISTRY rows (upper-case keys)."""
    if not champion:
        return None
    others = [m for m in models if m["ALGORITHM"] != champion["ALGORITHM"] and not m.get("IS_ACTIVE")]
    return max(others, key=lambda m: str(m["TRAINED_AT"] or ""), default=None)


def model_card(m: dict | None, top: int = 5) -> dict | None:
    if not m:
        return None
    fi = importance_list(m.get("FEATURE_IMPORTANCE"), m.get("ALGORITHM"))
    return {"version": m["MODEL_VERSION"], "algorithm": m["ALGORITHM"], "active": bool(m.get("IS_ACTIVE")),
            "auc": float(m["AUC"]) if m.get("AUC") is not None else None,
            "gini": float(m["GINI"]) if m.get("GINI") is not None else None,
            "kind": "coefficient" if is_scorecard(m.get("ALGORITHM")) else "importance",
            "top": fi[:top]}


def same_holdout(a: str | None, b: str | None) -> bool:
    """Trained by the same TRAIN_MODEL call (v7 and v7-lr): measured on the same hold-out loans."""
    if not a or not b:
        return False
    return a.split("-")[0] == b.split("-")[0]


def build_comparison(models: list[dict], run_id: str | None, summary: dict | None,
                     transitions: list[dict], changed: list[dict]) -> dict[str, Any]:
    """Pure: registry rows + the run's shadow-scoring results -> the comparison payload.

    `summary` is one row (CHAMPION, CHALLENGER, N, GRADES_CHANGED, DECISIONS_CHANGED, CHAMPION_PD,
    CHALLENGER_PD) or None when the run has no challenger scores yet."""
    by_v = {m["MODEL_VERSION"]: m for m in models}
    active = next((m for m in models if m.get("IS_ACTIVE")), None)
    if summary:  # the run decided with its champion; compare against that one
        champ = by_v.get(summary["CHAMPION"]) or active
        chall = by_v.get(summary["CHALLENGER"])
    else:
        champ = active
        chall = pick_challenger(models, active)
    out: dict[str, Any] = {
        "run_id": run_id,
        "active_version": active["MODEL_VERSION"] if active else None,
        "champion": model_card(champ),
        "challenger": model_card(chall),
        "same_holdout": same_holdout(champ and champ["MODEL_VERSION"], chall and chall["MODEL_VERSION"]),
        "scored": bool(summary),
        "companies": 0, "grades_changed": 0, "decisions_changed": 0,
        "champion_mean_pd": None, "challenger_mean_pd": None,
        "transitions": [], "changed": [],
    }
    if summary:
        out.update(companies=int(summary["N"] or 0), grades_changed=int(summary["GRADES_CHANGED"] or 0),
                   decisions_changed=int(summary["DECISIONS_CHANGED"] or 0),
                   champion_mean_pd=float(summary["CHAMPION_PD"]) if summary.get("CHAMPION_PD") is not None else None,
                   challenger_mean_pd=(float(summary["CHALLENGER_PD"]) if summary.get("CHALLENGER_PD") is not None
                                       else None))
        out["transitions"] = sorted(({"from": t["FROM_DECISION"], "to": t["TO_DECISION"], "n": int(t["N"])}
                                     for t in transitions), key=lambda t: -t["n"])
        out["changed"] = [{"cif_id": c["CIF_ID"], "legal_name": c["LEGAL_NAME"],
                           "from": c["FROM_DECISION"], "to": c["TO_DECISION"],
                           "champion_pd": float(c["CHAMPION_PD"]), "challenger_pd": float(c["CHALLENGER_PD"]),
                           "champion_grade": c["CHAMPION_GRADE"], "challenger_grade": c["CHALLENGER_GRADE"]}
                          for c in changed]
    return out
