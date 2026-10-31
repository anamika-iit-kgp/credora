"""Feature labels and plain-English reasons for the Exasol report (pure functions, no I/O)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class FeatureDef:
    name: str
    label: str
    unit: str | None  # inr | pct | ratio | years | None (plain number)
    source: str


FEATURES: list[FeatureDef] = [
    FeatureDef("gst_years", "Years of GST filing", "years", "api.gstn"),
    FeatureDef("gst_turnover_12m", "GST turnover, last 12 months", "inr", "api.gstn"),
    FeatureDef("gst_late_filings_12m", "Late GST filings, last 12 months", None, "api.gstn"),
    FeatureDef("gst_bank_gap_pct", "Gap between GST turnover and bank credits", "pct", "exasol"),
    FeatureDef("avg_balance_12m", "Average balance, last 12 months", "inr", "bank.oracle"),
    FeatureDef("inflow_volatility", "Inflow volatility (stddev / mean)", None, "bank.oracle"),
    FeatureDef("bounce_ratio", "Bounced debits / all debits", "ratio", "bank.oracle"),
    FeatureDef("cmr_rank", "CIBIL CMR rank (1 best, 10 worst)", None, "api.cibil"),
    FeatureDef("partner_min_score", "Lowest partner CIBIL score", None, "api.cibil"),
    FeatureDef("partner_avg_score", "Average partner CIBIL score", None, "api.cibil"),
    FeatureDef("partner_overdue_amt", "Partners' overdue amount", "inr", "api.cibil"),
    FeatureDef("partner_other_bank_bal", "Partners' balances at other banks", "inr", "api.aa"),
    FeatureDef("dscr", "Debt service coverage ratio", None, "exasol"),
]
BY_NAME = {f.name: f for f in FEATURES}


def inr(v: float | int | None) -> str:
    """Indian-style short rupees: ₹2.85 cr, ₹43.8 L, ₹9,500."""
    if v is None:
        return "–"
    v = float(v)
    a = abs(v)
    sign = "-" if v < 0 else ""
    if a >= 1e7:
        s = f"{a / 1e7:.2f}".rstrip("0").rstrip(".")
        return f"{sign}₹{s} cr"
    if a >= 1e5:
        s = f"{a / 1e5:.1f}".rstrip("0").rstrip(".")
        return f"{sign}₹{s} L"
    return f"{sign}₹{a:,.0f}"


def feature_list(row: dict[str, Any] | None) -> list[dict]:
    """CREDORA.FEATURES row (upper-case columns) -> report features."""
    if not row:
        return []
    out = []
    for f in FEATURES:
        v = row.get(f.name.upper())
        if f.name in ("gst_late_filings_12m", "cmr_rank", "partner_min_score") and v is not None:
            v = int(v)
        out.append({"name": f.name, "label": f.label, "value": v, "unit": f.unit, "source": f.source})
    return out


def _num(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def reason_text(name: str, value: Any) -> str:
    """Plain-English statement of one feature's value. Direction is shown separately by the UI."""
    v = _num(value)
    f = BY_NAME.get(name)
    if v is None:
        return f.label if f else name.replace("_", " ").capitalize()
    match name:
        case "gst_years":
            return f"{v:g} years of GST filing history"
        case "gst_turnover_12m":
            return f"GST turnover of {inr(v)} in the last 12 months"
        case "gst_late_filings_12m":
            n = int(v)
            if n == 0:
                return "Every GST return in the last 12 months was filed on time"
            return f"{n} of the last 12 GST returns {'was' if n == 1 else 'were'} filed late or not at all"
        case "gst_bank_gap_pct":
            return f"GST turnover and bank credits differ by {v:.1f}%"
        case "avg_balance_12m":
            return f"Average current-account balance of {inr(v)} over 12 months"
        case "inflow_volatility":
            return f"Monthly inflows swing by {v * 100:.0f}% around their average"
        case "bounce_ratio":
            return "No bounced debits in 12 months" if v == 0 else f"{v * 100:.1f}% of debits bounced"
        case "cmr_rank":
            return f"CIBIL commercial rank CMR-{int(v)}"
        case "partner_min_score":
            return f"Lowest partner CIBIL score is {int(v)}"
        case "partner_avg_score":
            return f"Average partner CIBIL score is {v:g}"
        case "partner_overdue_amt":
            return "No overdue amounts on partners' personal credit" if v == 0 else \
                f"Partners have {inr(v)} overdue on personal credit"
        case "partner_other_bank_bal":
            return f"Partners hold {inr(v)} at other banks"
        case "dscr":
            return f"Cash flow covers debt service {v:.2f} times"
    return f"{name}: {value}"


def parse_contributions(raw: str | dict | None) -> dict[str, float]:
    if not raw:
        return {}
    d = json.loads(raw) if isinstance(raw, str) else raw
    return {k: float(v) for k, v in d.items() if v is not None}


def reasons(contributions: dict[str, float], features_row: dict[str, Any] | None,
            per_side: int = 4, limit: int = 8) -> list[dict]:
    """Top drivers in both directions.

    `contributions` are CREDORA.SCORES.CONTRIBUTIONS: feature -> change in PD (0..1) against the
    portfolio median. The report shows them in percentage points of PD; positive raises the risk.
    """
    items = [(k, v) for k, v in contributions.items() if abs(v) >= 5e-6]
    up = sorted((x for x in items if x[1] > 0), key=lambda x: -x[1])[:per_side]
    down = sorted((x for x in items if x[1] < 0), key=lambda x: x[1])[:per_side]
    chosen = sorted(up + down, key=lambda x: -abs(x[1]))[:limit]
    out = []
    for name, delta in chosen:
        value = features_row.get(name.upper()) if features_row else None
        f = BY_NAME.get(name)
        out.append({
            "feature": name,
            "text": reason_text(name, value),
            "contribution": round(delta * 100, 3),
            "source": f.source if f else "exasol",
        })
    return out
