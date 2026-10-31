import json

from app.challenger import build_comparison, importance_list, pick_challenger, same_holdout
from app.routes.analysis import anomaly_view

GBM = "Gradient-boosted trees (scikit-learn HistGradientBoosting, monotonic)"
LR = "LogisticRegression scorecard"


def reg(v, algo, active=False, at="2026-10-31 13:33:58", auc=0.75):
    fi = {"cmr_rank": 0.29, "avg_balance_12m": -0.47, "dscr": 0.01} if algo == LR else {"cmr_rank": 0.02, "dscr": 0.04}
    return {"MODEL_VERSION": v, "ALGORITHM": algo, "IS_ACTIVE": active, "TRAINED_AT": at, "AUC": auc,
            "GINI": 2 * auc - 1, "FEATURE_IMPORTANCE": json.dumps(fi)}


def test_importance_orders_coefficients_by_size_keeping_the_sign():
    lr = importance_list(json.dumps({"a": 0.1, "b": -0.5, "c": 0.3}), LR)
    assert [x["feature"] for x in lr] == ["b", "c", "a"] and lr[0]["importance"] == -0.5
    gbm = importance_list(json.dumps({"a": 0.1, "b": -0.5, "c": 0.3}), GBM)
    assert [x["feature"] for x in gbm] == ["c", "a", "b"]
    assert importance_list(None) == []


def test_pick_challenger_is_newest_inactive_model_of_another_algorithm():
    models = [reg("v1", GBM, at="2026-10-30"), reg("v2", GBM, True, at="2026-10-31"),
              reg("v1-lr", LR, at="2026-10-30"), reg("v2-lr", LR, at="2026-10-31")]
    assert pick_challenger(models, models[1])["MODEL_VERSION"] == "v2-lr"
    flipped = [dict(m, IS_ACTIVE=m["MODEL_VERSION"] == "v2-lr") for m in models]
    assert pick_challenger(flipped, flipped[3])["MODEL_VERSION"] == "v2"
    assert pick_challenger(models[:2], models[1]) is None
    assert pick_challenger(models, None) is None


def test_same_holdout():
    assert same_holdout("v2", "v2-lr") and not same_holdout("v1", "v2-lr") and not same_holdout(None, "v2")


def test_build_comparison_with_and_without_shadow_scores():
    models = [reg("v2", GBM, True, auc=0.7561), reg("v2-lr", LR, auc=0.7692)]
    bare = build_comparison(models, None, None, [], [])
    assert bare["champion"]["version"] == "v2" and bare["challenger"]["version"] == "v2-lr"
    assert bare["challenger"]["kind"] == "coefficient" and bare["challenger"]["top"][0]["feature"] == "avg_balance_12m"
    assert bare["same_holdout"] and not bare["scored"] and bare["decisions_changed"] == 0

    summary = {"CHAMPION": "v2", "CHALLENGER": "v2-lr", "N": 1000, "GRADES_CHANGED": 713, "DECISIONS_CHANGED": 61,
               "CHAMPION_PD": 0.081, "CHALLENGER_PD": 0.079}
    out = build_comparison(models, "R1", summary,
                           [{"FROM_DECISION": "REFER", "TO_DECISION": "APPROVE", "N": 20},
                            {"FROM_DECISION": "APPROVE", "TO_DECISION": "REFER", "N": 41}],
                           [{"CIF_ID": "C000001", "LEGAL_NAME": "A Ltd", "FROM_DECISION": "APPROVE",
                             "TO_DECISION": "REFER", "CHAMPION_PD": 0.03, "CHALLENGER_PD": 0.13,
                             "CHAMPION_GRADE": "B1", "CHALLENGER_GRADE": "D"}])
    assert out["scored"] and out["companies"] == 1000 and out["grades_changed"] == 713
    assert out["decisions_changed"] == 61 and out["transitions"][0] == {"from": "APPROVE", "to": "REFER", "n": 41}
    assert out["changed"][0]["challenger_grade"] == "D" and out["active_version"] == "v2"


def test_anomaly_view():
    assert anomaly_view(None) is None
    v = anomaly_view({"SCORE": 0.6612345, "IS_ANOMALY": True,
                      "TOP_REASONS": "GST turnover far above bank credits, bank inflows unusually volatile"})
    assert v == {"score": 0.6612, "flagged": True,
                 "reasons": ["GST turnover far above bank credits", "bank inflows unusually volatile"]}
