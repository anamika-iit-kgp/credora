"""Hidden risk model.

Each borrower has a latent risk z ~ N(0, 1); higher is riskier. The same
functions turn z into (a) the behaviour used to simulate a live company's data
and (b) the features stored for historical loans, so a model trained on
los.past_loan learns a relationship that also holds for the current companies.
Feature formulas are documented in docs/DATA_MODEL.md ("Feature definitions").
"""

from dataclasses import dataclass

import numpy as np

PD_INTERCEPT = -3.05
PD_SLOPE = 1.25
NO_HISTORY_SCORE = 650      # stands in for a bureau score of -1 in partner features
LOAN_RATE = 0.11            # pricing assumption used by the DSCR feature


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def true_pd(z):
    """Probability of default within the loan horizon (mean about 8%)."""
    return sigmoid(PD_INTERCEPT + PD_SLOPE * np.asarray(z))


@dataclass
class Behaviour:
    z: float
    p_late: float          # GST return filed after the due date
    p_missing: float       # GST return never filed
    gst_bank_gap: float    # |GST turnover - bank credits| / GST turnover
    gap_sign: int          # -1 bank credits below GST turnover, +1 above
    volatility: float      # month-to-month noise in sales
    growth: float          # yearly turnover growth
    p_bounce: float        # chance a cheque / NACH debit is returned
    margin: float          # share of credits retained in the account
    cushion: float         # opening balance in months of credits
    cmr_rank: int
    suit_filed: bool
    wilful_default: bool


def behaviour(z: float, rng: np.random.Generator) -> Behaviour:
    up = max(z, -0.5) + 0.5
    return Behaviour(
        z=z,
        p_late=float(sigmoid(-2.4 + 1.1 * z)),
        p_missing=float(sigmoid(-4.8 + 1.3 * z)),
        gst_bank_gap=float(np.clip(abs(rng.normal(0.03 + 0.075 * up, 0.02 + 0.02 * up)), 0.0, 0.85)),
        gap_sign=-1 if rng.random() < 0.75 else 1,
        volatility=float(np.clip(rng.normal(0.12 + 0.06 * z, 0.03), 0.04, 0.5)),
        growth=float(rng.normal(0.10 - 0.07 * z, 0.06)),
        p_bounce=float(sigmoid(-4.7 + 1.05 * z)),
        margin=float(rng.normal(0.035 - 0.025 * z, 0.012)),
        cushion=float(np.exp(rng.normal(-0.6 - 0.45 * z, 0.3))),
        cmr_rank=int(np.clip(round(4 + 1.8 * z + rng.normal(0, 0.9)), 1, 10)),
        suit_filed=bool(rng.random() < sigmoid(-6.0 + 1.6 * z)),
        wilful_default=bool(rng.random() < sigmoid(-8.5 + 2.0 * z)),
    )


def partner_latent(z: float, rng: np.random.Generator, size: int) -> np.ndarray:
    """Promoters' personal credit risk is correlated with the company's."""
    return 0.7 * z + 0.71 * rng.normal(size=size)


def bureau_score(pz: float, rng: np.random.Generator) -> int:
    return int(np.clip(round(rng.normal(765 - 78 * pz, 22)), 300, 900))


def other_bank_balance(z: float, rng: np.random.Generator) -> float:
    """Opening balance of an account at another bank."""
    return round(float(np.exp(rng.normal(13.0 - 0.45 * z, 0.7))), 2)


def loan_request(rng: np.random.Generator, annual_turnover: float, z: float) -> tuple[str, float, int]:
    """(product, amount, tenure months). Riskier firms ask for more relative to turnover."""
    stretch = float(np.exp(0.15 * z))
    if rng.random() < 0.6:
        amount = annual_turnover * rng.uniform(0.12, 0.25) * stretch
        tenure = int(rng.choice([12, 12, 12, 24, 36]))
        product = "WC"
    else:
        amount = annual_turnover * rng.uniform(0.10, 0.40) * stretch
        tenure = int(rng.choice([24, 36, 48, 60, 72, 84]))
        product = "TL"
    return product, max(round(amount, -5), 500000.0), tenure


def annual_debt_service(product: str, amount: float, tenure: int) -> float:
    """WC: interest only. TL: twelve EMIs at LOAN_RATE over the tenure."""
    if product == "WC":
        return amount * LOAN_RATE
    r = LOAN_RATE / 12
    return 12 * amount * r / (1 - (1 + r) ** -tenure)


def dscr(gst_turnover_12m: float, product: str, amount: float, tenure: int) -> float:
    return gst_turnover_12m * 0.12 / annual_debt_service(product, amount, tenure)
