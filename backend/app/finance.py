"""Quote checks and the what-if decision rule. The numbers are computed in Exasol; this module
builds the SQL and turns Exasol's answer into reasons. Python reference formulas are kept for tests."""

from __future__ import annotations

import re
from typing import Any

from .excerpts_code import CODE
from .features import inr

# ---------------------------------------------------------------- quote

QUOTE_SQL = """
WITH cfg AS (
  SELECT MAX(CASE WHEN CONFIG_KEY = 'FUNDS_COST_PCT' THEN CONFIG_VALUE END) FUNDS,
         MAX(CASE WHEN CONFIG_KEY = 'OPEX_PCT' THEN CONFIG_VALUE END) OPEX,
         MAX(CASE WHEN CONFIG_KEY = 'LGD_PCT' THEN CONFIG_VALUE END) LGD,
         MAX(CASE WHEN CONFIG_KEY = 'CAPITAL_PCT' THEN CONFIG_VALUE END) CAPITAL,
         MAX(CASE WHEN CONFIG_KEY = 'HURDLE_PCT' THEN CONFIG_VALUE END) HURDLE
  FROM CREDORA.CONFIG),
d AS (
  SELECT PD, PRODUCT, DECISION, FLOOR_ROI, MAX_AMOUNT, MAX_TENURE, LGD_PCT
  FROM CREDORA.DECISIONS WHERE RUN_ID = {run} AND APP_ID = {app}),
t AS (SELECT CAST({amount!d} AS DOUBLE) AMT, CAST({roi!d} AS DOUBLE) ROI, CAST({tenure!d} AS DOUBLE) TEN FROM DUAL)
SELECT ROUND((t.ROI - cfg.FUNDS - cfg.OPEX - d.PD * COALESCE(d.LGD_PCT, cfg.LGD)) / cfg.CAPITAL * 100, 3) RAROC,
       ROUND(CASE WHEN d.PRODUCT = 'TL'
                  THEN t.AMT * (t.ROI / 1200) / (1 - POWER(1 + t.ROI / 1200, -t.TEN))
                  ELSE t.AMT * t.ROI / 1200 END, 0) EMI,
       t.AMT <= d.MAX_AMOUNT AMOUNT_OK, t.ROI >= d.FLOOR_ROI ROI_OK, t.TEN <= d.MAX_TENURE TENURE_OK,
       ROUND((t.ROI - cfg.FUNDS - cfg.OPEX - d.PD * COALESCE(d.LGD_PCT, cfg.LGD)) / cfg.CAPITAL * 100, 3) >= cfg.HURDLE RAROC_OK,
       cfg.HURDLE, d.FLOOR_ROI, d.MAX_AMOUNT, d.MAX_TENURE, d.PRODUCT, d.DECISION, d.PD,
       COALESCE(d.LGD_PCT, cfg.LGD) LGD
FROM d CROSS JOIN cfg CROSS JOIN t
"""


def dec(x: float | int) -> str:
    """Plain decimal text for pyexasol's {x!d} placeholder."""
    s = f"{float(x):.6f}".rstrip("0").rstrip(".")
    return s or "0"


def quote_params(run_id: str, app_id: str, amount: float, roi: float, tenure: int) -> dict[str, Any]:
    return {"run": run_id, "app": app_id, "amount": dec(amount), "roi": dec(roi), "tenure": dec(tenure)}


def quote_result(row: dict[str, Any]) -> dict[str, Any]:
    """Exasol's quote row -> {within_limit, raroc, emi, lgd_pct, reasons}. lgd_pct is the loss given
    default the RAROC used: the decision's own figure after collateral, else the policy LGD."""
    reasons: list[str] = []
    if not row.get("AMOUNT_OK"):
        reasons.append(f"Amount is above the maximum of {inr(row.get('MAX_AMOUNT'))}.")
    if not row.get("ROI_OK"):
        reasons.append(f"ROI is below the floor of {float(row.get('FLOOR_ROI') or 0):.2f}%.")
    if not row.get("TENURE_OK"):
        reasons.append(f"Tenure is longer than the maximum of {row.get('MAX_TENURE')} months.")
    raroc = float(row["RAROC"])
    hurdle = float(row["HURDLE"])
    if not row.get("RAROC_OK"):
        reasons.append(f"RAROC {raroc:.1f}% is below the {hurdle:g}% hurdle.")
    within = not reasons
    if within:
        reasons.append(f"Within limit. RAROC {raroc:.1f}% meets the {hurdle:g}% hurdle.")
    lgd = row.get("LGD")
    return {"within_limit": within, "raroc": round(raroc, 2), "emi": float(row["EMI"]),
            "lgd_pct": None if lgd is None else float(lgd), "reasons": reasons}


def emi_ref(amount: float, roi: float, tenure: int, product: str = "TL") -> float:
    """Reference formula, mirrors QUOTE_SQL: TL amortises, WC pays interest only."""
    r = roi / 1200
    if product == "TL":
        return amount * r / (1 - (1 + r) ** -tenure)
    return amount * r


def raroc_ref(roi: float, pd: float, funds: float, opex: float, lgd: float, capital: float) -> float:
    """Mirrors RAROC_OFFER in RUN_ANALYSIS step 11 (all inputs in %, pd 0..1). lgd is the effective
    loss given default after collateral, see lgd_ref."""
    return (roi - funds - opex - pd * lgd) / capital * 100


def lgd_ref(lgd_unsecured: float, lgd_collateral: float | None, collateral_value: float, amount: float) -> float:
    """Mirrors LGD_EFF in the decision SQL: the collateral type's LGD on the share of the credit need
    the collateral covers, the unsecured policy LGD on the rest (all LGDs in %)."""
    cover = min(collateral_value / amount, 1.0) if amount else 0.0
    lgd_c = lgd_unsecured if lgd_collateral is None else lgd_collateral
    return round(lgd_unsecured + (lgd_c - lgd_unsecured) * cover, 2)


def exposure_room_ref(turnover: float, existing_exposure: float | None, max_exposure_pct: float) -> float:
    """Mirrors EXPOSURE_ROOM in the decision SQL: the cap as a share of GST turnover less what the
    company already owes all lenders, never below 0."""
    return max(turnover * max_exposure_pct / 100 - (existing_exposure or 0.0), 0.0)


# ---------------------------------------------------------------- what-if

def _decide_sql() -> tuple[str, str, str]:
    """Split RUN_ANALYSIS step 11 (the decision SQL, anomaly referral included) into (cfg select,
    CTEs after cfg, decision CASE)."""
    sql = CODE[11][1]
    m_cfg = re.search(r"WITH cfg AS \(\n(.*?FROM CREDORA\.CONFIG)\),\n", sql, flags=re.S)
    m_final = re.search(r"\nSELECT :r, APP_ID", sql)
    m_case = re.search(r"CASE WHEN FAILS IS NOT NULL THEN 'DECLINE'.*?ELSE 'APPROVE' END", sql, flags=re.S)
    if not (m_cfg and m_final and m_case):
        raise RuntimeError("RUN_ANALYSIS step 11 no longer has the expected shape; update finance.py")
    ctes = sql[m_cfg.end():m_final.start()]
    return m_cfg.group(1), ctes, m_case.group(0)


WHATIF_KEYS = {"hurdle_pct": "HURDLE", "eblr_pct": "EBLR", "max_gst_share_pct": "GST_SHARE"}
CFG_COLS = ["EBLR", "OPS", "FUNDS", "OPEX", "LGD", "CAPITAL", "HURDLE", "GST_SHARE", "MIN_DSCR", "NEG_DSCR",
            "FLOOR_MARGIN", "MARGIN_DEFAULT", "MAX_EXPOSURE"]


def whatif_sql(overrides: dict[str, float | None]) -> str:
    """One query: re-run the decision rule of RUN_ANALYSIS over a run's stored features and
    scores with overridden policy values; returns decision counts and offer amounts (AMT) before
    (stored) and after."""
    cfg_select, ctes, case = _decide_sql()
    over = {WHATIF_KEYS[k]: v for k, v in overrides.items() if k in WHATIF_KEYS and v is not None}
    cols = ", ".join(f"CAST({dec(over[c])} AS DECIMAL(12,4)) {c}" if c in over else c for c in CFG_COLS)
    body = ctes.replace(":r", "{run}")
    return (f"WITH cfg0 AS (\n{cfg_select}),\ncfg AS (SELECT {cols} FROM cfg0),\n{body}"
            f",\nafter_run AS (SELECT {case} DECISION, CASE WHEN FAILS IS NULL THEN OFFER_AMT END AMT FROM judged)\n"
            f"SELECT 'after' K, DECISION, COUNT(*) N, SUM(AMT) AMT FROM after_run GROUP BY DECISION\n"
            f"UNION ALL\n"
            f"SELECT 'before' K, DECISION, COUNT(*) N, SUM(OFFER_AMOUNT) AMT FROM CREDORA.DECISIONS "
            f"WHERE RUN_ID = {{run}} GROUP BY DECISION")


def mix_from(rows: list[dict], key: str) -> dict[str, int]:
    m = {"APPROVE": 0, "REFER": 0, "DECLINE": 0}
    for r in rows:
        if r["K"] == key and r["DECISION"] in m:
            m[r["DECISION"]] = int(r["N"])
    return m


def preapproved_from(rows: list[dict], key: str) -> float:
    """Total pre-approved offer amount: the offer amounts of APPROVE decisions."""
    return float(sum(float(r.get("AMT") or 0) for r in rows if r["K"] == key and r["DECISION"] == "APPROVE"))
