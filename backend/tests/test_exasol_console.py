"""Explain mode: the Exasol console (per-user ring buffer, secret redaction) and the control room."""

from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app import console, exa
from app.auth import issue_token, make_user
from app.main import app
from app.routes import exasol as routes

c = TestClient(app)


def h(role, session=None):
    out = {"Authorization": f"Bearer {issue_token(make_user(role))}"}
    if session:
        out["X-Credora-Session"] = session
    return out


@pytest.fixture(autouse=True)
def _clean():
    console.clear()
    routes._cache.clear()
    yield
    console.clear()
    routes._cache.clear()


# ---------------------------------------------------------------- redaction

def test_redacts_identified_by_and_connection_parts():
    sql = "CREATE OR REPLACE CONNECTION ORA_CBS TO 'db.example:1521/SAPPHIRE' USER 'CREDORA_RO' IDENTIFIED BY 'p@ss'"
    out = console.redact(sql)
    assert "p@ss" not in out and "db.example" not in out and "CREDORA_RO" not in out
    assert "CONNECTION ORA_CBS" in out
    assert console.redact("ALTER USER X IDENTIFIED BY \"Secret1\"") == "ALTER USER X IDENTIFIED BY '***'"


def test_redacts_secret_looking_literals_and_keeps_ordinary_ones():
    sql = ("SELECT 'sk-ant-api03-abc', 'eyJhbGciOiJIUzI1NiJ9.x.y', 'aB3dE5gH7jK9mN1pQ3sT5vX7', "
           "'https://user:pw@host/x', 'password=1', 'C000001', 'APPROVE', "
           "'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', "
           "'/buckets/bfsdefault/default/models/pd_v3.pkl', 'Refresh virtual schemas' FROM DUAL")
    out = console.redact(sql)
    for gone in ("sk-ant", "eyJhbG", "aB3dE5gH7jK9mN1pQ3sT5vX7", "user:pw", "password=1"):
        assert gone not in out
    for kept in ("'C000001'", "'APPROVE'", "9f86d081884c7d65", "pd_v3.pkl", "'Refresh virtual schemas'"):
        assert kept in out


def test_redacts_configured_secrets(monkeypatch):
    monkeypatch.setattr(console, "_known_secrets", lambda: ["Zq9-not-a-real-secret"])
    assert "Zq9-not-a-real-secret" not in console.redact("SELECT * FROM T WHERE X = 'Zq9-not-a-real-secret'")
    assert "Zq9-not-a-real-secret" not in (console.redact("mixed Zq9-not-a-real-secret text") or "")


def test_error_text_is_redacted_and_short():
    console.statement("CREDORA_SVC", "ALTER USER U IDENTIFIED BY 'x'", 1.0, None,
                      RuntimeError("bad password 'Hunter2Hunter2Hunter2X' (Session: 123)"))
    e = console.entries("", everyone=True)[-1]
    assert "IDENTIFIED BY '***'" in e["sql"] and "Session" not in e["error"]


# ---------------------------------------------------------------- per-user isolation

class _St:
    result_type = "resultSet"

    def __init__(self, sql):
        self.sql = sql

    def column_names(self):
        return ["X"]

    def __iter__(self):
        return iter([(1,)])

    def rowcount(self):
        return 1


class _Fmt:
    @staticmethod
    def format(sql, **params):
        return sql.format(**{k: f"'{v}'" for k, v in params.items()})


class _Conn:
    format = _Fmt()

    def execute(self, sql, query_params=None):
        if "BOOM" in sql:
            raise RuntimeError("insufficient privileges: SELECT on table BOOM (Session: 1)")
        return _St(sql)


@pytest.fixture
def fake_exasol(monkeypatch):
    @contextmanager
    def connection(user):
        yield _Conn()
    monkeypatch.setattr(exa, "connection", connection)
    monkeypatch.setattr(exa, "db_timezone", lambda: None)


def test_statements_carry_user_feature_and_exasol_user(fake_exasol):
    r = c.get("/api/exasol/control-room", headers=h("rm", "tabA"))
    assert r.status_code == 200
    mine = c.get("/api/exasol/console", headers=h("rm", "tabA")).json()
    assert mine["entries"], "the control room's statements are in the rm's console"
    e = mine["entries"][0]
    assert e["username"] == "rm" and e["exa_user"] == "CREDORA_RM" and e["label"] == "Exasol control room"
    assert e["session"] == "tabA" and e["kind"] == "sql" and e["ms"] is not None
    assert not e["sql"].startswith("/*"), "the console shows the statement without the audit tag"


def test_console_is_per_user_and_per_session(fake_exasol):
    c.get("/api/exasol/control-room", headers=h("rm", "tabA"))
    # another person sees none of it
    for role in ("admin", "datasci", "loanops"):
        assert c.get("/api/exasol/console", headers=h(role, "tabA")).json()["entries"] == []
    # another browser session of the same login sees none of it either, unless it asks for scope=user
    assert c.get("/api/exasol/console", headers=h("rm", "tabB")).json()["entries"] == []
    assert c.get("/api/exasol/console?scope=user", headers=h("rm", "tabB")).json()["entries"]


def test_only_admin_sees_everyone(fake_exasol):
    c.get("/api/exasol/control-room", headers=h("rm", "tabA"))
    for role in ("datasci", "loanops", "rm"):
        assert c.get("/api/exasol/console?scope=all", headers=h(role)).status_code == 403
    every = c.get("/api/exasol/console?scope=all", headers=h("admin")).json()["entries"]
    assert any(e["username"] == "rm" for e in every)


def test_since_returns_only_newer_entries(fake_exasol):
    c.get("/api/exasol/control-room", headers=h("datasci", "s1"))
    first = c.get("/api/exasol/console", headers=h("datasci", "s1")).json()
    again = c.get(f"/api/exasol/console?since={first['last']}", headers=h("datasci", "s1")).json()
    assert again["entries"] == [] and again["last"] == first["last"]


def test_console_needs_sign_in():
    assert c.get("/api/exasol/console").status_code == 401
    assert c.get("/api/exasol/control-room").status_code == 401


def test_repeated_poll_is_one_entry_with_a_count():
    tok = console.bind(username="datasci", role="datasci", session="s", label="Run analysis")
    try:
        for _ in range(5):
            console.statement("CREDORA_SVC", "SELECT STEP_NO FROM CREDORA.RUN_LOG WHERE RUN_ID = 'R1'", 3.0, 2)
    finally:
        console.unbind(tok)
    es = console.entries("datasci")
    assert len(es) == 1 and es[0]["repeat"] == 5


def test_ring_buffer_keeps_the_latest(monkeypatch):
    tok = console.bind(username="loanops", role="loanops", session=None, label="x")
    try:
        for i in range(console.MAX_PER_USER + 30):
            console.statement("CREDORA_LOANOPS", f"SELECT {i} FROM DUAL", 1.0, 1)
    finally:
        console.unbind(tok)
    es = console.entries("loanops")
    assert len(es) == console.MAX_PER_USER and es[-1]["sql"].endswith(f"{console.MAX_PER_USER + 29} FROM DUAL")


def test_mcp_call_shows_the_path_and_sql():
    tok = console.bind(username="rm", role="rm", session="t", label="Ask Credora")
    try:
        console.mcp_call("execute_exasol_query", {"query": "SELECT approved_companies FROM CREDORA_SEM.PORTFOLIO"},
                         "CREDORA_RM", 42.0)
    finally:
        console.unbind(tok)
    e = console.entries("rm")[0]
    assert e["kind"] == "mcp" and "exasol-mcp-server" in e["via"] and "CREDORA_RM" in e["via"]
    assert "CREDORA_SEM.PORTFOLIO" in e["sql"]


# ---------------------------------------------------------------- control room

def _fake_query(denied_for: set[str]):
    def q(user, sql, params=None):
        s = " ".join(sql.split())
        if user in denied_for and ("MODEL_REGISTRY" in s or "EXA_DBA_" in s):
            raise RuntimeError("insufficient privileges: SELECT on table MODEL_REGISTRY (Session: 9)")
        if "CURRENT_USER" in s:
            return [{"U": user, "S": 1}]
        if "databaseProductVersion" in s:
            return [{"PARAM_VALUE": "2026.1.0"}]
        if "EXA_SYSTEM_EVENTS" in s:
            return [{"NODES": 1, "VCPU": 4, "DB_RAM_SIZE": 23.5}]
        if "FROM EXA_ALL_SCHEMAS" in s:
            names = ["CREDORA", "CREDORA_SEM"] + ([] if user == "CREDORA_RM" else ["VS_CBS", "CREDORA_STAGE"])
            return [{"SCHEMA_NAME": n, "SCHEMA_OWNER": "SYS", "SCHEMA_IS_VIRTUAL": n.startswith("VS_"),
                     "SCHEMA_COMMENT": None} for n in names]
        if "FROM EXA_ALL_OBJECTS" in s:
            return [{"ROOT_NAME": "CREDORA", "OBJECT_TYPE": "VIEW", "N": 11 if user == "CREDORA_RM" else 13}]
        if "EXA_ALL_VIRTUAL_SCHEMAS" in s:
            return [{"SCHEMA_NAME": "VS_CIF", "ADAPTER_SCRIPT_SCHEMA": "ADBC_VS", "ADAPTER_SCRIPT_NAME": "ADBC_ADAPTER",
                     "LAST_REFRESH": "2026-10-31T09:00:00Z", "LAST_REFRESH_BY": "CREDORA_SVC",
                     "ADAPTER_NOTES": '{"driver":"mysql","driverVersion":"0.6.1","connection":"MYSQL_CIF"}'}]
        if "EXA_ALL_SCRIPTS" in s:
            return [{"SCRIPT_SCHEMA": "CREDORA", "SCRIPT_NAME": "PD_SCORE", "SCRIPT_TYPE": "UDF",
                     "SCRIPT_LANGUAGE": "PYTHON3", "SCRIPT_INPUT_TYPE": "SET", "SCRIPT_RESULT_TYPE": "EMITS",
                     "SCRIPT_COMMENT": None},
                    {"SCRIPT_SCHEMA": "PREPROC_RT", "SCRIPT_NAME": "P_ABC", "SCRIPT_TYPE": "SCRIPTING",
                     "SCRIPT_LANGUAGE": "LUA", "SCRIPT_INPUT_TYPE": None, "SCRIPT_RESULT_TYPE": "ROWCOUNT",
                     "SCRIPT_COMMENT": None}]
        if "EXA_ALL_CONNECTIONS" in s:
            return [{"CONNECTION_NAME": "MOCK_CIBIL", "CREATED": "2026-10-31T09:00:00Z"}]
        if "MODEL_REGISTRY" in s:
            return [{"MODEL_VERSION": "v3", "ALGORITHM": "trees", "TRAINED_AT": None, "AUC": 0.75, "GINI": 0.5,
                     "N_TRAIN": 4000, "MODEL_PATH": "/buckets/bfsdefault/default/models/pd_v3.pkl", "IS_ACTIVE": True}]
        if "EXA_DBA_ROLE_PRIVS" in s or "EXA_USER_ROLE_PRIVS" in s:
            return [{"GRANTEE": user, "GRANTED_ROLE": "R_" + user.split("_", 1)[1]}]
        if "SYS_PRIVS" in s:
            return [{"GRANTEE": "R_RM", "PRIVILEGE": "CREATE SESSION"}]
        if "OBJ_PRIVS" in s:
            return [{"GRANTEE": "R_RM", "PRIVILEGE": "SELECT", "OBJECT_TYPE": "VIEW", "OBJECT_SCHEMA": "CREDORA",
                     "OBJECT_NAME": "V_RM_DECISIONS"},
                    {"GRANTEE": "SEMANTIC_USER", "PRIVILEGE": "SELECT", "OBJECT_TYPE": "SCHEMA",
                     "OBJECT_SCHEMA": None, "OBJECT_NAME": "SEMANTIC_CATALOG"}]
        if "EXA_DBA_USERS" in s:
            return [{"USER_NAME": "CREDORA_RM"}]
        if "EXA_PARAMETERS" in s:
            return [{"PARAMETER_NAME": "SQL_PREPROCESSOR_SCRIPT", "SESSION_VALUE": "PREPROC_RT.P_X",
                     "SYSTEM_VALUE": "PREPROC_RT.MASTER"},
                    {"PARAMETER_NAME": "SCRIPT_LANGUAGES", "SESSION_VALUE": "",
                     "SYSTEM_VALUE": "JAVA=builtin_java PYTHON3=builtin_python3 "
                                     "RUST=localzmq+protobuf:///bfsdefault/default/slc/rustslc?lang=rust#buckets/x"}]
        if "SEMANTIC_CATALOG.MODELS" in s:
            return [{"MODEL_NAME": "credora", "PUBLISHED_SCHEMA": "CREDORA_SEM", "STATUS": "PUBLISHED",
                     "SURFACE_TYPE": "VIEW_PREPROCESSOR", "ACTIVE_VERSION_NUMBER": 1, "DESCRIPTION": "d"}]
        if "SEMANTIC_CATALOG.METRICS" in s:
            return [{"METRIC_NAME": "approved_companies", "DISPLAY_NAME": "Pre-approved companies", "DESCRIPTION": "x",
                     "EXPRESSION": "SUM(company_count)", "FILTER_EXPR": None, "METRIC_KIND": "FILTERED",
                     "IS_CERTIFIED": True}]
        if "PRODUCT_VERSION" in s:
            return [{"DISPLAY_VERSION": "0.5.1"}]
        if "RUN_LOG" in s:
            return [{"RUN_ID": "R1", "STEP_NO": 1, "STEP_NAME": "Refresh virtual schemas", "STATUS": "OK",
                     "ROWS_OUT": 3, "MS": 1838, "LOGGED_AT": None}]
        if "EXA_DBA_SESSIONS" in s:
            return [{"SESSION_ID": 5, "USER_NAME": "CREDORA_SVC", "STATUS": "IDLE", "COMMAND_NAME": "NOT SPECIFIED",
                     "DURATION": "0:01:00", "LOGIN_TIME": None, "CLIENT": "credora:system:web", "DRIVER": "PyExasol ",
                     "CONSUMER_GROUP": "CREDORA_APP"}]
        return []
    return q


def test_control_room_reads_as_the_role_and_shows_refusals(monkeypatch):
    calls = []
    fq = _fake_query({"CREDORA_RM"})

    def q(user, sql, params=None):
        calls.append(user)
        return fq(user, sql, params)

    monkeypatch.setattr(exa, "query", q)
    rm = c.get("/api/exasol/control-room", headers=h("rm")).json()
    assert set(calls) == {"CREDORA_RM"}, "every read runs as the rm's own Exasol user"
    assert rm["exasol_user"] == "CREDORA_RM" and rm["system"]["data"]["current_user"] == "CREDORA_RM"
    assert rm["models"]["ok"] is False and rm["models"]["denied"] is True
    assert rm["sessions"] is None
    assert rm["security"]["data"]["scope"] == "own"
    assert all(r["role"].startswith("R_") for r in rm["security"]["data"]["roles"])
    assert [s["name"] for s in rm["schemas"]["data"]] == ["CREDORA", "CREDORA_SEM"]

    calls.clear()
    admin = c.get("/api/exasol/control-room", headers=h("admin")).json()
    assert set(calls) == {"CREDORA_ADMIN"}
    assert admin["models"]["ok"] and admin["models"]["data"][0]["path"].endswith("pd_v3.pkl")
    assert admin["sessions"]["ok"] and admin["security"]["data"]["scope"] == "dba"
    assert len(admin["schemas"]["data"]) > len(rm["schemas"]["data"])
    vs = admin["virtual_schemas"]["data"][0]
    assert vs["adapter"] == "ADBC_VS.ADBC_ADAPTER" and vs["driver"] == "mysql" and vs["extension"] == "adbc-vs-rs"
    assert [s["name"] for s in admin["scripts"]["data"]["items"]] == ["PD_SCORE"]
    langs = {lang["alias"]: lang for lang in admin["preprocessor"]["data"]["languages"]}
    assert langs["PYTHON3"]["builtin"] and not langs["RUST"]["builtin"]
    assert admin["preprocessor"]["data"]["system"] == "PREPROC_RT.MASTER"
    assert admin["semantic"]["data"]["metrics"][0]["certified"] is True


def test_control_room_never_exposes_connection_addresses(monkeypatch):
    monkeypatch.setattr(exa, "query", _fake_query(set()))
    body = c.get("/api/exasol/control-room", headers=h("admin")).text
    assert "CONNECTION_STRING" not in body and "IDENTIFIED" not in body
    conns = c.get("/api/exasol/control-room", headers=h("admin")).json()["connections"]["data"]
    assert set(conns[0]) == {"name", "created"}


def test_control_room_is_cached_per_role(monkeypatch):
    n = {"calls": 0}
    fq = _fake_query(set())

    def q(user, sql, params=None):
        n["calls"] += 1
        return fq(user, sql, params)

    monkeypatch.setattr(exa, "query", q)
    first = c.get("/api/exasol/control-room", headers=h("datasci")).json()
    calls = n["calls"]
    second = c.get("/api/exasol/control-room", headers=h("datasci")).json()
    assert first["cached"] is False and second["cached"] is True and n["calls"] == calls
    c.get("/api/exasol/control-room", headers=h("loanops"))
    assert n["calls"] > calls, "another role is read with its own Exasol user"
