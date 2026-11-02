from app.finance import key_facts


def test_term_loan_key_facts_amortise():
    k = key_facts(10_000_000, 12.0, 36, "TL")
    assert abs(k["monthly_payment"] - 332_143.10) < 0.01
    assert abs(k["total_repayment"] - k["monthly_payment"] * 36) < 0.5
    assert abs(k["total_interest"] - (k["total_repayment"] - 10_000_000)) < 0.5
    assert k["apr_pct"] == 12.0 and k["fee_pct"] == 0.0 and k["tenure_months"] == 36 and k["product"] == "TL"


def test_working_capital_pays_interest_only():
    k = key_facts(5_000_000, 10.0, 12, "WC")
    assert abs(k["monthly_payment"] - 5_000_000 * 10 / 1200) < 0.01
    assert abs(k["total_interest"] - k["monthly_payment"] * 12) < 0.5
    assert abs(k["total_repayment"] - (5_000_000 + k["total_interest"])) < 0.5
    assert k["apr_pct"] == 10.0
