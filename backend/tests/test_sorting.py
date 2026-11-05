"""The server sort of the paginated lists. Only fixed SQL reaches the statement."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import exa, runs, sorting
from app.auth import issue_token, make_user
from app.main import app
from app.routes.analysis import DECISION_SORT
from app.routes.explorer import COMPANY_SORT

c = TestClient(app)


def h(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


@pytest.fixture
def statements(monkeypatch):
    seen = []

    def query(_user, sql, params=None):
        seen.append(sql)
        return []

    monkeypatch.setattr(exa, "query", query)
    monkeypatch.setattr(exa, "scalar", lambda *a, **k: 0)
    monkeypatch.setattr(runs, "current_run", lambda _user: {"run_id": "R1"})
    return seen


def test_order_by_keeps_the_usual_order_without_a_sort():
    assert sorting.order_by({"a": "A"}, "", "asc", "ID") == "ID"
    assert sorting.order_by({"a": "A"}, "", "desc", "ID") == "ID"


def test_order_by_puts_blanks_last_in_both_directions_and_breaks_ties():
    assert sorting.order_by({"a": "A"}, "a", "asc", "ID") == "A ASC NULLS LAST, ID"
    assert sorting.order_by({"a": "A"}, "a", "desc", "ID") == "A DESC NULLS LAST, ID"


@pytest.mark.parametrize("bad", ["b", "A", "a;DROP TABLE x", "1", "__class__"])
def test_order_by_refuses_a_key_outside_the_map(bad):
    with pytest.raises(HTTPException) as e:
        sorting.order_by({"a": "A"}, bad, "asc", "ID")
    assert e.value.status_code == 422


@pytest.mark.parametrize("columns", [COMPANY_SORT, DECISION_SORT])
def test_the_maps_hold_no_placeholders_for_the_sql_formatter(columns):
    for fragment in columns.values():
        assert "{" not in fragment and "}" not in fragment


def test_companies_default_order_is_unchanged(statements):
    assert c.get("/api/companies", headers=h("admin")).status_code == 200
    assert " ORDER BY CIF_ID LIMIT {size!d} OFFSET {off!d}" in statements[-1]


@pytest.mark.parametrize("key,sql", list(COMPANY_SORT.items()))
def test_companies_sort_by_every_offered_column(statements, key, sql):
    r = c.get(f"/api/companies?sort={key}&order=desc", headers=h("admin"))
    assert r.status_code == 200
    assert f" ORDER BY {sql} DESC NULLS LAST, CIF_ID LIMIT" in statements[-1]


def test_companies_sort_works_for_a_relationship_manager(statements):
    assert c.get("/api/companies?sort=offer_amount", headers=h("rm")).status_code == 200
    assert "CREDORA.V_RM_COMPANY" in statements[-1]
    assert " ORDER BY OFFER_AMOUNT ASC NULLS LAST, CIF_ID LIMIT" in statements[-1]


def test_decisions_default_order_is_rank(statements):
    assert c.get("/api/decisions", headers=h("loanops")).status_code == 200
    assert "ORDER BY RANK_NO, CIF_ID LIMIT" in statements[-1]


@pytest.mark.parametrize("key,sql", list(DECISION_SORT.items()))
def test_decisions_sort_by_every_offered_column(statements, key, sql):
    r = c.get(f"/api/decisions?sort={key}", headers=h("loanops"))
    assert r.status_code == 200
    assert f"ORDER BY {sql} ASC NULLS LAST, RANK_NO, CIF_ID LIMIT" in statements[-1]


@pytest.mark.parametrize("path", ["/api/companies", "/api/decisions"])
@pytest.mark.parametrize("query", ["sort=1;DROP%20TABLE%20X", "sort=LEGAL_NAME", "sort=rank_no&order=sideways"])
def test_bad_sort_is_refused_before_any_statement_runs(statements, path, query):
    assert c.get(f"{path}?{query}", headers=h("admin")).status_code == 422
    assert statements == []
