"""GET /api/admin/rls-proof, the row filter shown by Exasol with one statement per relationship manager user."""

import dataclasses

from fastapi.testclient import TestClient

from app import exa
from app.auth import issue_token, make_user
from app.main import app
from app.routes import exasol as exasol_routes


def _auth(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


class FakeStatement:
    def __init__(self, value):
        self.value = value

    def fetchval(self):
        return self.value


class FakeConn:
    closed = 0

    def close(self):
        FakeConn.closed += 1


def _fake_exasol(monkeypatch, configured):
    monkeypatch.setattr(exasol_routes, "settings",
                        dataclasses.replace(exasol_routes.settings, exa_passwords=configured))
    opened = []
    monkeypatch.setattr(exa, "new_connection", lambda user: opened.append(user) or FakeConn())

    def execute(conn, user, sql, params=None):
        if "FROM CREDORA.DECISIONS" in sql:
            raise RuntimeError("insufficient privileges for selecting from table DECISIONS (Session: 17)")
        return FakeStatement(25 if user != "CREDORA_RM002" else 4)

    monkeypatch.setattr(exa, "traced_execute", execute)
    FakeConn.closed = 0
    return opened


def test_rls_proof_runs_each_user_on_its_own_connection(monkeypatch):
    opened = _fake_exasol(monkeypatch, {"CREDORA_RM": "a", "CREDORA_RM_AI": "b", "CREDORA_RM002": "c"})
    r = TestClient(app).get("/api/admin/rls-proof", headers=_auth("admin"))
    assert r.status_code == 200
    items = r.json()
    assert [i["exa_user"] for i in items] == ["CREDORA_RM", "CREDORA_RM_AI", "CREDORA_RM002", "CREDORA_RM"]
    assert all(set(i) == {"exa_user", "sql", "rows", "error", "ms"} for i in items)
    view = "SELECT COUNT(*) N FROM CREDORA.V_RM_DECISIONS"
    assert [i["sql"] for i in items] == [view, view, view, "SELECT COUNT(*) N FROM CREDORA.DECISIONS"]
    assert [i["rows"] for i in items] == [25, 25, 4, None]
    assert [i["error"] for i in items[:3]] == [None, None, None]
    assert items[3]["error"] == "insufficient privileges for selecting from table DECISIONS"
    assert all(isinstance(i["ms"], float) for i in items)
    assert opened == ["CREDORA_RM", "CREDORA_RM_AI", "CREDORA_RM002", "CREDORA_RM"] and FakeConn.closed == 4


def test_rls_proof_skips_a_user_without_a_password(monkeypatch):
    opened = _fake_exasol(monkeypatch, {"CREDORA_RM": "a", "CREDORA_RM_AI": "b"})
    items = TestClient(app).get("/api/admin/rls-proof", headers=_auth("datasci")).json()
    assert items[2] == {"exa_user": "CREDORA_RM002", "sql": "SELECT COUNT(*) N FROM CREDORA.V_RM_DECISIONS",
                        "rows": None, "error": "not configured", "ms": 0.0}
    assert "CREDORA_RM002" not in opened and FakeConn.closed == 3


def test_rls_proof_is_for_the_admin_and_the_data_scientist():
    c = TestClient(app)
    assert c.get("/api/admin/rls-proof", headers=_auth("rm")).status_code == 403
    assert c.get("/api/admin/rls-proof", headers=_auth("loanops")).status_code == 403
    assert c.get("/api/admin/rls-proof").status_code == 401
