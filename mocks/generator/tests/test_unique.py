"""Uniqueness helpers for append mode. Run from the repo root inside the generator image:

    docker run --rm --user root -v "$PWD/mocks/generator/tests:/app/tests" -w /app mocks-generator
        sh -c "pip install -q pytest && python -m pytest -q -p no:cacheprovider tests"
"""

import numpy as np
from faker import Faker

from generator import ids, reference as ref
from generator.job import merge_counts
from generator.synth import Existing, Names, build_world


def names(seed=1, **kw):
    return Names(Faker("en_IN"), np.random.default_rng(seed), **kw)


def test_name_lists_have_no_repeats_and_no_clash_between_first_and_last_names():
    for lst in (ref.FIRST_NAMES_M, ref.FIRST_NAMES_F, ref.LAST_NAMES, ref.NAME_PREFIXES, ref.NAME_QUALIFIERS):
        assert len(lst) == len(set(lst))
    assert not set(ref.FIRST_NAMES_M + ref.FIRST_NAMES_F) & set(ref.LAST_NAMES)


def test_person_names_stay_unique_past_20000():
    n = names()
    drawn = [n.person("M" if i % 5 else "F") for i in range(25_000)]
    assert len(set(drawn)) == len(drawn)


def test_person_names_avoid_names_already_in_use():
    taken = {f"{f} {l}" for f in ref.FIRST_NAMES_M for l in ref.LAST_NAMES}
    n = names(people=taken)
    drawn = [n.person("M") for _ in range(500)]
    assert not set(drawn) & taken
    assert all(". " in d for d in drawn)      # every plain name is taken, so all carry an initial


def test_firm_names_avoid_names_already_in_use():
    first = names(seed=3)
    taken = {first.firm("Textiles", "Private Limited") for _ in range(2000)}
    again = names(seed=3, firms=taken)
    drawn = [again.firm("Textiles", "Private Limited") for _ in range(2000)]
    assert len(set(drawn)) == 2000 and not set(drawn) & taken


def test_unique_ids_respect_taken_values():
    rng = np.random.default_rng(0)
    first = ids.UniqueIds(rng)
    taken = {first.sapphire_account() for _ in range(1000)} | {first.pan("P", "Shah") for _ in range(1000)}
    second = ids.UniqueIds(np.random.default_rng(0), taken=taken)
    assert not {second.sapphire_account() for _ in range(1000)} & taken
    assert not {second.pan("P", "Shah") for _ in range(1000)} & taken


def test_append_world_continues_every_sequence_and_keeps_values_unique():
    base = build_world(11, n_companies=100)
    ex = Existing(rms=base.rms, last_cif=100, last_partner=len(base.partners), last_app=100, last_txn=999,
                  has_past_loans=True, company_names={c.legal_name for c in base.companies},
                  person_names={p.name for p in base.partners},
                  pans={c.pan for c in base.companies} | {p.pan for p in base.partners},
                  gstins={c.gstin for c in base.companies}, account_nos={c.account_no for c in base.companies},
                  aa_ids={a[0] for a in base.aa_accounts})
    more = build_world(11, n_companies=100, existing=ex)
    assert more.companies[0].cif_id == "C000101" and more.applications[0][0] == "A0000101"
    assert more.partners[0].partner_id == ids.partner_id(len(base.partners) + 1)
    assert more.past_loans == [] and not more.new_rms and more.txn_start == 999
    assert {c.rm_id for c in more.companies} <= {r[0] for r in base.rms}
    both = base.companies + more.companies
    people = base.partners + more.partners
    for values in ([c.legal_name for c in both], [c.pan for c in both] + [p.pan for p in people],
                   [c.gstin for c in both], [p.name for p in people], [c.account_no for c in both],
                   [a[0] for a in base.aa_accounts + more.aa_accounts]):
        assert len(values) == len(set(values))
    assert base.rms[0][1] == "Subhashree Mohanty"


def test_merge_counts_adds_rows_to_what_was_there():
    assert merge_counts({"cif.company": 1000, "crm.offer": 5}, {"cif.company": 1000, "cif.rm": 0}) == {
        "cif.company": 2000, "crm.offer": 5, "cif.rm": 0}
