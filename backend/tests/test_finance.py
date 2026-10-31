import re

import pytest

from app.finance import QUOTE_SQL, dec, emi_ref, mix_from, quote_params, quote_result, raroc_ref, whatif_sql


def test_raroc_matches_run_analysis_formula():
    # A stored R3 decision: ROI 13%, PD 0.050503, config 6.5 / 1 / 45 / 12 -> RAROC_OFFER 26.895
    assert raroc_ref(13, 0.050503, 6.5, 1, 45, 12) == pytest.approx(26.895, abs=1e-3)


def test_emi_term_loan_and_working_capital():
    assert emi_ref(1_000_000, 12, 12, "TL") == pytest.approx(88848.79, abs=0.01)
    assert emi_ref(1_000_000, 12, 12, "WC") == pytest.approx(10000.0)


def test_quote_within_limit():
    q = quote_result({"AMOUNT_OK": True, "ROI_OK": True, "TENURE_OK": True, "RAROC_OK": True, "RAROC": 20.5,
                      "HURDLE": 15, "EMI": 12345, "MAX_AMOUNT": 1e7, "FLOOR_ROI": 11.6, "MAX_TENURE": 84})
    assert q["within_limit"] is True
    assert q["reasons"] == ["Within limit. RAROC 20.5% meets the 15% hurdle."]
    assert q["emi"] == 12345.0


def test_quote_outside_limit_lists_every_breach():
    q = quote_result({"AMOUNT_OK": False, "ROI_OK": False, "TENURE_OK": False, "RAROC_OK": False, "RAROC": 9.25,
                      "HURDLE": 15, "EMI": 1, "MAX_AMOUNT": 14000000, "FLOOR_ROI": 11.6, "MAX_TENURE": 84})
    assert q["within_limit"] is False
    assert q["reasons"] == ["Amount is above the maximum of ₹1.4 cr.", "ROI is below the floor of 11.60%.",
                            "Tenure is longer than the maximum of 84 months.", "RAROC 9.2% is below the 15% hurdle."]


def test_quote_params_are_plain_decimals():
    p = quote_params("R3", "A0000001", 12500000.0, 11.75, 60)
    assert p == {"run": "R3", "app": "A0000001", "amount": "12500000", "roi": "11.75", "tenure": "60"}
    assert dec(0) == "0" and dec(0.5) == "0.5"
    assert "{amount!d}" in QUOTE_SQL and "{run}" in QUOTE_SQL


def test_whatif_sql_reuses_the_decision_rule_with_overrides():
    sql = whatif_sql({"hurdle_pct": 18, "eblr_pct": None, "max_gst_share_pct": 25})
    cfg = sql.split("cfg AS (SELECT ")[1].split("FROM cfg0")[0]
    assert "CAST(18 AS DECIMAL(12,4)) HURDLE" in cfg
    assert "CAST(25 AS DECIMAL(12,4)) GST_SHARE" in cfg
    assert cfg.startswith("EBLR,")  # not overridden
    assert "judged AS" in sql and "PARTNER_MIN_SCORE < 600" in sql
    assert ":r" not in sql and sql.count("{run}") == 2
    assert not re.search(r"\{(?!run\})", sql)  # only {run} placeholders reach pyexasol's formatter


def test_whatif_without_overrides_is_the_stored_rule():
    sql = whatif_sql({})
    assert "CAST(" not in sql.split("cfg AS (SELECT ")[1].split("FROM cfg0")[0]


def test_mix_from():
    rows = [{"K": "before", "DECISION": "APPROVE", "N": 545}, {"K": "after", "DECISION": "REFER", "N": 3}]
    assert mix_from(rows, "before") == {"APPROVE": 545, "REFER": 0, "DECLINE": 0}
    assert mix_from(rows, "after") == {"APPROVE": 0, "REFER": 3, "DECLINE": 0}
