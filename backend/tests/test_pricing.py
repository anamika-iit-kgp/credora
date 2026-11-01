"""The pricing rule of docs/PRICING.md: industry cash margin, LGD by collateral and the exposure cap,
as the decision SQL (excerpt of RUN_ANALYSIS step 11), the quote and the report carry them."""

import re

import pytest

from app.excerpts_code import CODE
from app.finance import CFG_COLS, QUOTE_SQL, exposure_room_ref, lgd_ref, quote_result
from app.routes.analysis import pricing_view


def test_decision_sql_reads_the_reference_tables_and_stores_the_inputs():
    decide = CODE[11][1]
    assert "LEFT JOIN CREDORA.INDUSTRY_MARGIN im ON im.INDUSTRY = a.INDUSTRY" in decide
    assert "LEFT JOIN CREDORA.LGD_COLLATERAL lc ON lc.COLLATERAL_TYPE = a.COLLATERAL_TYPE" in decide
    assert "* 0.12" not in decide, "the flat 12% cash assumption is back"
    assert "COALESCE(im.CASH_MARGIN_PCT, cfg.MARGIN_DEFAULT) / 100 CASH" in decide
    assert "PD * LGD_EFF" in decide and "PD * LGD)" not in decide
    assert decide.count("LEAST(EXPOSURE_ROOM,") == 2  # the offer and the negotiation limit
    assert "CASH_MARGIN_PCT, LGD_PCT, EXISTING_EXPOSURE, EXPOSURE_ROOM)" in decide
    assert "';Existing exposure near the cap'" in decide


def test_feature_sql_uses_the_industry_margin_and_keeps_the_cibil_exposure():
    features = CODE[7][1]
    assert "LEFT JOIN CREDORA.INDUSTRY_MARGIN im ON im.INDUSTRY = app.INDUSTRY" in features
    assert "CASH_MARGIN_DEFAULT_PCT" in features and "* 0.12" not in features
    assert "gst.STAGE, com.TOTAL_EXPOSURE" in features


def test_whatif_config_columns_cover_the_decision_sql():
    cfg = re.search(r"WITH cfg AS \(\n(.*?FROM CREDORA\.CONFIG)\),\n", CODE[11][1], flags=re.S).group(1)
    aliases = re.findall(r"CONFIG_VALUE END\) (\w+)", cfg)
    assert aliases == CFG_COLS, "finance.CFG_COLS must list every cfg column, in order"


def test_lgd_blends_by_coverage():
    assert lgd_ref(45, None, 0, 1e7) == 45            # unsecured, or an unknown type
    assert lgd_ref(45, 35, 1.2e7, 1e7) == 35          # receivables covering the whole need
    assert lgd_ref(45, 35, 5e6, 1e7) == 40            # half covered
    assert lgd_ref(45, 0, 2.5e6, 1e7) == 33.75        # a deposit covering a quarter
    assert lgd_ref(45, 35, 1e7, 0) == 45


def test_exposure_room_is_the_cap_less_existing_exposure_never_negative():
    assert exposure_room_ref(1e8, 2e7, 60) == 4e7
    assert exposure_room_ref(1e8, None, 60) == 6e7
    assert exposure_room_ref(1e8, 9e7, 60) == 0


def test_quote_uses_the_decision_lgd_and_returns_it():
    assert QUOTE_SQL.count("COALESCE(d.LGD_PCT, cfg.LGD)") == 3
    q = quote_result({"AMOUNT_OK": True, "ROI_OK": True, "TENURE_OK": True, "RAROC_OK": True, "RAROC": 20.5,
                      "HURDLE": 15, "EMI": 1, "LGD": 35})
    assert q["lgd_pct"] == 35.0
    assert quote_result({"AMOUNT_OK": True, "ROI_OK": True, "TENURE_OK": True, "RAROC_OK": True, "RAROC": 1,
                         "HURDLE": 1, "EMI": 1})["lgd_pct"] is None


def test_pricing_view():
    d = {"CASH_MARGIN_PCT": 9, "LGD_PCT": 37.5, "EXISTING_EXPOSURE": 2e7, "EXPOSURE_ROOM": 4e7}
    f = {"GST_TURNOVER_12M": 1e8}
    c = {"INDUSTRY": "Textiles", "COLLATERAL_TYPE": "Receivables", "COLLATERAL_VALUE": 5e6}
    assert pricing_view(d, f, c) == {
        "industry": "Textiles", "cash_margin_pct": 9.0, "cash_12m": 9e6, "collateral_type": "Receivables",
        "collateral_value": 5e6, "lgd_pct": 37.5, "existing_exposure": 2e7, "exposure_room": 4e7}
    assert pricing_view(d, None, None)["cash_12m"] is None
    assert pricing_view({"OFFER_AMOUNT": 1e7}, f, c) is None  # a run from before the columns existed


@pytest.mark.parametrize("col", ["CASH_MARGIN_PCT", "LGD_PCT", "EXISTING_EXPOSURE", "EXPOSURE_ROOM"])
def test_new_decision_columns_are_created_and_migrated(col):
    from pathlib import Path
    schemas = Path(__file__).resolve().parents[2] / "exasol" / "sql" / "01_schemas.sql"
    if not schemas.exists():
        pytest.skip("repo Exasol scripts not present")
    text = schemas.read_text(encoding="utf-8")
    assert text.count(col + " DECIMAL(") == 2  # CREATE TABLE and the ALTER in PRICING_MIGRATE
