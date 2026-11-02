"""The cash margin per industry behind the DSCR of past loans stays in step with the Exasol seed
(exasol/sql/18_pricing_reference.sql), which prices the companies analysed now."""

import re
from pathlib import Path

import pytest

from generator import reference as ref
from generator.risk import CASH_MARGIN_DEFAULT, dscr

SEED = Path(__file__).resolve().parents[3] / "exasol" / "sql" / "18_pricing_reference.sql"


def test_every_industry_has_a_cash_margin():
    assert set(ref.CASH_MARGIN_PCT) == set(ref.INDUSTRIES)
    assert all(3 <= v <= 30 for v in ref.CASH_MARGIN_PCT.values())


@pytest.mark.skipif(not SEED.exists(), reason="repo Exasol scripts not present")
def test_cash_margins_match_the_exasol_seed():
    text = SEED.read_text(encoding="utf-8")
    block = text.split("CREDORA.INDUSTRY_MARGIN m USING (", 1)[1].split(") s ON", 1)[0]
    seeded = {m.group(1): float(m.group(2)) for m in re.finditer(r"SELECT '([^']+)'(?: i)?, (\d+\.\d+)", block)}
    assert seeded == ref.CASH_MARGIN_PCT


def test_dscr_uses_the_industry_margin():
    assert dscr(1e8, "WC", 1e7, 12, 0.09) == pytest.approx(1e8 * 0.09 / (1e7 * 0.11))
    assert dscr(1e8, "WC", 1e7, 12) == pytest.approx(1e8 * CASH_MARGIN_DEFAULT / (1e7 * 0.11))
    assert dscr(1e8, "TL", 1e7, 60, 0.18) > dscr(1e8, "TL", 1e7, 60, 0.09)
