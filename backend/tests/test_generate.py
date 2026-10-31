import pytest
from pydantic import ValidationError

from app.jobs import generate_result
from app.routes.core import GenerateBody


def test_generate_body_defaults_to_replace_1000():
    b = GenerateBody()
    assert (b.seed, b.mode, b.companies) == (None, "replace", 1000)
    b = GenerateBody(seed=7, mode="append", companies=2500)
    assert (b.seed, b.mode, b.companies) == (7, "append", 2500)


@pytest.mark.parametrize("bad", [{"mode": "merge"}, {"companies": 99}, {"companies": 5001}])
def test_generate_body_rejects_bad_mode_and_counts(bad):
    with pytest.raises(ValidationError):
        GenerateBody(**bad)


def test_generate_result_passes_counts_through_once_known():
    started = generate_result({"job_id": "x", "seed": 42}, "append", 1000)
    assert started == {"seed": 42, "mode": "append", "companies": 1000}
    done = generate_result({"seed": 42, "mode": "append", "companies": 1000,
                            "counts": {"cif.company": 2000}, "added": {"cif.company": 1000}}, "replace", 5)
    assert done["mode"] == "append" and done["companies"] == 1000
    assert done["counts"]["cif.company"] == 2000 and done["added"]["cif.company"] == 1000
