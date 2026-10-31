from app.features import feature_list, inr, parse_contributions, reason_text, reasons


def test_inr_short_forms():
    assert inr(28472480) == "₹2.85 cr"
    assert inr(10000000) == "₹1 cr"
    assert inr(4380864) == "₹43.8 L"
    assert inr(9500) == "₹9,500"
    assert inr(None) == "–"


def test_reasons_take_top_drivers_in_both_directions_in_pp():
    contrib = {"avg_balance_12m": -0.017783, "inflow_volatility": -0.023857, "partner_overdue_amt": 0.009238,
               "gst_years": 0.004618, "bounce_ratio": 0.0, "dscr": 0.0, "partner_other_bank_bal": 0.003474,
               "cmr_rank": -0.002452, "gst_turnover_12m": -0.006508, "partner_avg_score": -0.01064}
    out = reasons(contrib, {"INFLOW_VOLATILITY": 0.1757, "PARTNER_OVERDUE_AMT": 0, "AVG_BALANCE_12M": 25869727.12},
                  per_side=3, limit=6)
    names = [r["feature"] for r in out]
    assert names[0] == "inflow_volatility"
    assert sum(r["contribution"] > 0 for r in out) == 3
    assert sum(r["contribution"] < 0 for r in out) == 3
    assert "bounce_ratio" not in names  # zero contribution is not a driver
    assert out[0]["contribution"] == -2.386  # percentage points of PD
    assert abs(out[0]["contribution"]) >= abs(out[-1]["contribution"])
    assert out[0]["text"] == "Monthly inflows swing by 18% around their average"
    assert out[0]["source"] == "bank.oracle"


def test_reasons_without_feature_values_fall_back_to_labels():
    out = reasons({"partner_min_score": 0.02}, None)
    assert out[0]["text"] == "Lowest partner CIBIL score"


def test_reason_texts():
    assert reason_text("gst_late_filings_12m", 0).startswith("Every GST return")
    assert reason_text("gst_late_filings_12m", 1) == "1 of the last 12 GST returns was filed late or not at all"
    assert reason_text("bounce_ratio", 0.0032) == "0.3% of debits bounced"
    assert reason_text("partner_min_score", 567) == "Lowest partner CIBIL score is 567"
    assert reason_text("cmr_rank", 5) == "CIBIL commercial rank CMR-5"


def test_feature_list_and_contributions_parse():
    row = {"GST_YEARS": 6.6, "CMR_RANK": 5.0, "PARTNER_MIN_SCORE": 567, "DSCR": 1.303}
    fl = feature_list(row)
    assert len(fl) == 13
    by = {f["name"]: f for f in fl}
    assert by["gst_years"]["unit"] == "years" and by["gst_years"]["value"] == 6.6
    assert by["cmr_rank"]["value"] == 5 and isinstance(by["cmr_rank"]["value"], int)
    assert by["gst_turnover_12m"]["value"] is None
    assert feature_list(None) == []
    assert parse_contributions('{"a": 0.1, "b": null}') == {"a": 0.1}
