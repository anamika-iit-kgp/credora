"""Credora's Exasol SQL on a throwaway Exasol (exasol/docker-db), as GitHub Actions runs it.

Applies the SQL, Lua and UDF files in the order of deploy/credora.py through deploy/sql_runner.py,
creates the roles, users and consumer groups through deploy/exasol_setup.py, loads one analysis
run of 50 synthetic companies (fixtures.sql), runs the decision SQL and the PREFERRING ranking on
it (ci_scripts.sql), seeds the relationship manager's book, and then checks as each Exasol user
what Exasol lets it see. The purge is run as the service user and its proof is recomputed.

Needs a reachable docker-db with the default sys password, for example

    docker run --name exasoldb --detach --privileged --stop-timeout 120 -p 127.0.0.1:8563:8563 exasol/docker-db:2026.1.0
    python tests/exasol/run_docker_db.py

Every check is a plain assert. No file under exasol/ is changed. See tests/exasol/README.md.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import secrets
import ssl
import sys
import time

import pyexasol

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "deploy"))

import exasol_setup as es  # noqa: E402
import sql_runner  # noqa: E402

RUN = "CI-RUN-1"
DRAFT = "CI-RUN-DRAFT"
DOCKER_DB_PASSWORD = "exasol"  # the sys password exasol/docker-db ships with

# The files deploy/credora.py applies, in its order, split at the points where the deploy tool
# does something between them. Each file goes through sql_runner.run_file as on a deployment.
BEFORE_DATA = [  # credora.py EXASOL_SQL, with the placeholders of 02_connections.sql filled
    "exasol/sql/01_schemas.sql",
    "exasol/sql/02_connections.sql",
    "exasol/udf/04_api_udfs.sql",
    "exasol/udf/05_ml_udfs.sql",
    "exasol/udf/09_ai_udf.sql",
    "exasol/lua/06_run_analysis.sql",
    "exasol/lua/08_purge.sql",
]
AFTER_DATA = ["exasol/sql/07_security.sql", "exasol/sql/13_rm_row_security.sql"]  # credora.py EXASOL_SQL_AFTER_DATA
AFTER_USERS = ["exasol/sql/16_resources.sql", "exasol/sql/17_scheduler.sql"]
VIEWS = ["exasol/semantic/11_latest_run_views.sql"]  # plain views, needs no semantic layer
COMMENTS = ["exasol/sql/15_comments.sql"]
RM_BOOK = ["exasol/sql/14_seed_rm_book.sql"]
# What docker-db cannot run, and why. Everything else deploy/credora.py applies runs here.
SKIPPED = {
    "exasol/sql/03_virtual_schemas.sql":
        "the virtual schemas need the Oracle adapter, the adbc-vs-rs Rust adapter and the three RDS databases",
    "exasol/extensions/10_semantic_views_module.sql":
        "the module joins the preprocessor framework to exasol-semantic-views, which is not installed here",
    "exasol/semantic/12_credora_model.sql":
        "the semantic model needs exasol-semantic-views, installed by its own release installer",
}
# Steps of deploy/credora.py that are not SQL files and cannot run here either, and why.
SKIPPED_STEPS = {
    "deploy/exasol_setup.py install_semantic_views":
        "exasol-semantic-views is installed by its own release installer, which the semantic model needs",
    "deploy/exasol_setup.py install_preprocessor_library":
        "the module resolver fetches each module from GitHub from inside Exasol, and that UDF crashed on the GitHub runner",
}
# Stand-ins, so the grants in 07_security.sql resolve: three empty schemas with the names of the
# virtual schemas. Nothing reads them.
STUB_SCHEMAS = ("VS_CBS", "VS_CIF", "VS_LOS")
# Placeholder values for 02_connections.sql. CREATE CONNECTION stores them and connects to nothing.
PLACEHOLDERS = {
    "ORACLE_HOST": "oracle.invalid", "ORACLE_PORT": "1521", "ORACLE_SERVICE": "CBS", "ORACLE_RO_PASSWORD": "placeholder",
    "MYSQL_HOST": "mysql.invalid", "MYSQL_PORT": "3306", "MYSQL_RO_PASSWORD": "placeholder",
    "PG_HOST": "postgres.invalid", "PG_PORT": "5432", "PG_RO_PASSWORD": "placeholder",
    "MOCK_CIBIL_URL": "http://127.0.0.1:8101", "MOCK_GSTN_URL": "http://127.0.0.1:8102",
    "MOCK_AA_URL": "http://127.0.0.1:8103", "MOCK_API_TOKEN": "placeholder",
    "EXASOL_PRIVATE_IP": "127.0.0.1", "BUCKETFS_WRITE_PASSWORD": "placeholder",
}
# The staging tables PURGE_EXPIRED purges and the key it fingerprints, as 08_purge.sql states them.
# The auditor's rule: sort the expiring rows of a run by key, cut them into chunks of 1,000, hash
# each chunk, and hash the chunk hashes in chunk order.
PURGE_TARGETS = {
    "CIBIL_CONSUMER": "PAN || SCORE || TOTAL_OVERDUE",
    "CIBIL_COMMERCIAL": "PAN || CMR_RANK || OVERDUE",
    "GST_FILING": "GSTIN || GST_PERIOD || GSTR1_TURNOVER",
    "AA_ACCOUNT": "PAN || AA_ACCOUNT_ID || CURRENT_BALANCE",
}
# Tables role R_RM holds no grant on: Exasol must refuse a direct read of each.
RM_REFUSED = ("CREDORA.DECISIONS", "CREDORA.SCORES", "CREDORA.FEATURES", "CREDORA.APPLICATIONS",
              "CREDORA.V_COMPANY_MASKED", "CREDORA.ANOMALY", "CREDORA.RM_ASSIGNMENT", "CREDORA_STAGE.GST_FILING")


def say(msg: str) -> None:
    print(f"\n== {msg}", flush=True)


def wait_for_exasol(ex: es.Exasol, timeout: int) -> None:
    deadline = time.time() + timeout
    while True:
        try:
            with ex.connect() as c:
                c.execute("SELECT 1").fetchval()
            return
        except Exception as e:  # noqa: BLE001 - not up yet
            if time.time() > deadline:
                raise SystemExit(f"Exasol did not answer within {timeout} s: {e}")
            time.sleep(5)


def apply(c: pyexasol.ExaConnection, files: list[str], values: dict | None = None) -> None:
    for f in files:
        print(f"   {f}")
        sql_runner.run_file(c, ROOT / f, values, quiet=True)


def refused(conn: pyexasol.ExaConnection, sql: str) -> bool:
    """True when Exasol refuses the statement for want of a privilege."""
    try:
        conn.execute(sql).fetchall()
    except pyexasol.ExaQueryError as e:
        return getattr(e, "code", "") == "42500" or "insufficient privileges" in str(e).lower()
    return False


def count(conn: pyexasol.ExaConnection, obj: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {obj}").fetchval())


def cifs(conn: pyexasol.ExaConnection, obj: str) -> set[str]:
    return {r[0] for r in conn.execute(f"SELECT CIF_ID FROM {obj}").fetchall()}


def expected_fingerprints(conn: pyexasol.ExaConnection) -> dict[tuple[str, str], tuple[int, str]]:
    """What PURGE_LOG must show for the rows due now, by the auditor's rule."""
    out = {}
    for t, key in PURGE_TARGETS.items():
        rows = conn.execute(f"""
            SELECT RUN_ID, CAST(SUM(N) AS DECIMAL(18)) N, HASH_SHA256(LISTAGG(H, '|') WITHIN GROUP (ORDER BY CHUNK_NO)) H
            FROM (SELECT RUN_ID, CHUNK_NO, COUNT(*) N, HASH_SHA256(LISTAGG(K, '|') WITHIN GROUP (ORDER BY K)) H
                  FROM (SELECT RUN_ID, {key} K,
                               FLOOR((ROW_NUMBER() OVER (PARTITION BY RUN_ID ORDER BY {key}) - 1) / 1000) CHUNK_NO
                        FROM CREDORA_STAGE.{t} WHERE PURGE_AT <= SYSTIMESTAMP)
                  GROUP BY RUN_ID, CHUNK_NO)
            GROUP BY RUN_ID""").fetchall()
        for run_id, n, h in rows:
            out[(f"CREDORA_STAGE.{t}", run_id)] = (int(n), h)
    return out


def check_coverage() -> None:
    """Every SQL file deploy/credora.py names is applied or listed as skipped here, and nothing stale is."""
    named = set(re.findall(r'"(exasol/[a-z]+/\d\d_[a-z0-9_]+\.sql)"', (ROOT / "deploy" / "credora.py").read_text(encoding="utf-8")))
    here = set(BEFORE_DATA + AFTER_DATA + AFTER_USERS + VIEWS + COMMENTS + RM_BOOK) | set(SKIPPED)
    assert named == here, f"deploy/credora.py and this runner disagree: only in credora.py {sorted(named - here)}, only here {sorted(here - named)}"


def reset(c: pyexasol.ExaConnection) -> None:
    """Drop everything a previous run made, so the same docker-db serves another run (local use)."""
    for s in ("CREDORA", "CREDORA_STAGE", "SCHED") + STUB_SCHEMAS:
        c.execute(f"DROP SCHEMA IF EXISTS {s} CASCADE")
    for (name,) in c.execute("SELECT CONNECTION_NAME FROM EXA_DBA_CONNECTIONS").fetchall():
        c.execute(f"DROP CONNECTION {name}")
    for user in es.ROLE_USERS:
        c.execute(f"DROP USER IF EXISTS {user}")
    for role in {r for r, _ in es.ROLE_USERS.values()}:
        c.execute(f"DROP ROLE IF EXISTS {role}")
    have = {r[0] for r in c.execute("SELECT CONSUMER_GROUP_NAME FROM EXA_CONSUMER_GROUPS").fetchall()}
    for g in es.CONSUMER_GROUPS:
        if g in have:
            c.execute(f"DROP CONSUMER GROUP {g}")
    print("   reset: Credora schemas, connections, users, roles and consumer groups dropped")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1", help="the docker-db host (port 8563)")
    ap.add_argument("--wait", type=int, default=600, help="seconds to wait for Exasol to answer")
    ap.add_argument("--reset", action="store_true", help="drop everything Credora first (a second run on the same docker-db)")
    args = ap.parse_args()
    check_coverage()

    ex = es.Exasol(args.host, "sys", DOCKER_DB_PASSWORD, ssh_key="")
    say(f"Waiting for Exasol at {args.host}:8563")
    t0 = time.time()
    wait_for_exasol(ex, args.wait)

    def as_sys() -> pyexasol.ExaConnection:  # numbers as numbers, not strings
        return ex.connect(fetch_mapper=pyexasol.exasol_mapper)

    with as_sys() as c:
        version = c.execute("SELECT PARAM_VALUE FROM EXA_METADATA WHERE PARAM_NAME = 'databaseProductVersion'").fetchval()
        print(f"   Exasol {version} answered after {time.time() - t0:.0f} s")
        if args.reset:
            reset(c)

    # Throwaway passwords, made here, never stored. They satisfy the policy 16_resources.sql sets.
    secret = {key: f"Ci{secrets.token_hex(10)}Z" for _, key in es.ROLE_USERS.values()}

    def as_user(name: str) -> pyexasol.ExaConnection:
        return pyexasol.connect(dsn=f"{args.host}:8563", user=name, password=secret[es.ROLE_USERS[name][1]],
                                websocket_sslopt={"cert_reqs": ssl.CERT_NONE}, fetch_mapper=pyexasol.exasol_mapper)

    say("Roles, then the SQL files in deploy order")
    es.create_roles(ex)
    with as_sys() as c:
        apply(c, BEFORE_DATA, PLACEHOLDERS)
        for s in STUB_SCHEMAS:
            c.execute(f"CREATE SCHEMA IF NOT EXISTS {s}")
        print(f"   stub: empty schemas {', '.join(STUB_SCHEMAS)} in place of the virtual schemas")
        apply(c, AFTER_DATA, PLACEHOLDERS)
    es.create_users(ex, secret)
    es.ensure_consumer_groups(ex)
    with as_sys() as c:
        apply(c, AFTER_USERS)
    # The SQL preprocessing of deploy/credora.py semantic_layer, without the semantic layer itself:
    # the framework from its pinned release, the latest-run views, then the framework in the system
    # slot, so every role session from here on runs through it.
    es.install_preprocessor_framework(ex)
    with as_sys() as c:
        apply(c, VIEWS)
    es.activate_preprocessor(ex)
    with as_sys() as c:
        apply(c, COMMENTS)
        views = c.execute("SELECT VIEW_NAME FROM EXA_ALL_VIEWS WHERE VIEW_SCHEMA = 'CREDORA' ORDER BY 1").fetchall()
        for (view,) in views:
            c.execute(f'SELECT * FROM CREDORA."{view}" WHERE FALSE').fetchall()  # a view that does not compile raises
        print(f"   {len(views)} views in CREDORA compile")
    for f, why in SKIPPED.items():
        print(f"   skipped {f}: {why}")
    for step, why in SKIPPED_STEPS.items():
        print(f"   skipped {step}: {why}")

    say("One analysis run of 50 companies, written as CREDORA_SVC, decided and ranked by the real decision SQL")
    with as_sys() as c:
        sql_runner.run_file(c, HERE / "ci_scripts.sql", quiet=True)
    with as_user("CREDORA_SVC") as svc:
        sql_runner.run_file(svc, HERE / "fixtures.sql", quiet=True)
        decided, ranked, layers = svc.execute(f"EXECUTE SCRIPT CREDORA.CI_DECIDE_AND_RANK('{RUN}')").fetchone()
        print(f"   decided {decided}, {ranked} in the skyline over {layers} layers")
        assert refused(svc, "CREATE TABLE CREDORA.CI_NOT_ALLOWED (X INT)"), "CREDORA_SVC may not create tables"
    assert int(decided) == 50, decided
    with as_sys() as c:
        rows = c.execute(f"""SELECT APP_ID, DECISION, HARD_FAILS, OFFER_AMOUNT, AMOUNT_REQUESTED, OFFER_ROI, FLOOR_ROI,
                                    MAX_AMOUNT, RANK_NO, SKYLINE_LAYER, TOP50
                             FROM CREDORA.DECISIONS WHERE RUN_ID = '{RUN}'""").fetchall()
    assert len(rows) == 50, len(rows)
    tally: dict[str, int] = {}
    for app_id, decision, fails, offer, asked, roi, floor, max_amt, rank, layer, top50 in rows:
        n = int(app_id[1:])
        tally[decision] = tally.get(decision, 0) + 1
        if n % 10 == 0:
            assert decision == "DECLINE" and "Wilful defaulter" in fails and offer is None, (app_id, decision, fails, offer)
        elif n % 10 == 5:
            assert decision == "REFER" and "KYC PENDING" in fails, (app_id, decision, fails)
        elif n == 7:
            assert decision == "REFER" and "Anomaly:" in fails, (app_id, decision, fails)
        else:
            assert decision == "APPROVE" and fails is None, (app_id, decision, fails)
            assert 0 < offer <= asked and max_amt >= offer, (app_id, offer, asked, max_amt)
            assert roi >= floor, (app_id, roi, floor)
            assert top50 and layer is not None and rank <= 39, (app_id, top50, layer, rank)
        if decision != "APPROVE":
            assert not top50 and layer is None and rank > 39, (app_id, decision, top50, layer, rank)
    assert tally == {"APPROVE": 39, "REFER": 6, "DECLINE": 5}, tally
    assert sorted(r[8] for r in rows) == list(range(1, 51)), "RANK_NO is 1 to 50 once each"
    print(f"   {tally['APPROVE']} pre-approved offers, {tally['REFER']} referred, {tally['DECLINE']} declined")

    say("The relationship manager's book from 14_seed_rm_book.sql, then each user reads what Exasol allows")
    with as_sys() as c:
        apply(c, RM_BOOK)
        rm1 = cifs(c, "CREDORA.RM_ASSIGNMENT WHERE EXA_USER = 'CREDORA_RM'")
        rm2 = cifs(c, "CREDORA.RM_ASSIGNMENT WHERE EXA_USER = 'CREDORA_RM002'")
    assert len(rm1) == 25 and len(rm2) == 5 and not (rm1 & rm2), (len(rm1), len(rm2), rm1 & rm2)
    assert rm2 == {"C00001", "C00002", "C00003", "C00004", "C00006"}, rm2

    with as_user("CREDORA_RM") as rm:
        assert cifs(rm, "CREDORA.V_RM_ASSIGNMENT") == rm1
        assert cifs(rm, "CREDORA.V_RM_DECISIONS") == rm1
        assert cifs(rm, "CREDORA.V_RM_COMPANY") == rm1
        assert cifs(rm, "CREDORA.V_RM_FEATURES") == rm1
        assert count(rm, "CREDORA.V_RM_SCORES") == 25
        assert count(rm, "CREDORA.V_RM_LOAN_STATUS") == 0, "the other manager's status log is not hers"
        assert all(len(pan) == 10 for (pan,) in rm.execute("SELECT PAN FROM CREDORA.V_RM_COMPANY").fetchall()), \
            "her own companies are unmasked"
        assert rm.execute(f"SELECT RUN_ID FROM CREDORA.V_LATEST_RUN").fetchval() == RUN
        assert cifs(rm, "CREDORA.V_LATEST_DECISION") == rm1
        assert cifs(rm, "CREDORA.V_LATEST_COMPANY") == rm1
        assert count(rm, "CREDORA.V_LATEST_FEATURE") == 25
        assert count(rm, "CREDORA.CONFIG") == 12 and count(rm, "CREDORA.RUN_LOG") == 13
        for obj in RM_REFUSED:
            assert refused(rm, f"SELECT COUNT(*) FROM {obj}"), f"CREDORA_RM must not read {obj}"
        print(f"   CREDORA_RM sees its {len(rm1)} companies and is refused {len(RM_REFUSED)} direct reads")
        # Every read above went through the preprocessor framework in the system slot, as on a
        # deployment. A deploy session (sys here) has it switched off.
        pipeline = rm.execute("SELECT SESSION_VALUE FROM EXA_PARAMETERS WHERE PARAMETER_NAME = 'SQL_PREPROCESSOR_SCRIPT'").fetchval()
        assert pipeline and pipeline.upper().startswith("PREPROC_RT."), pipeline
        print(f"   CREDORA_RM's SQL goes through {pipeline}")
    with as_sys() as c:
        assert not c.execute("SELECT SESSION_VALUE FROM EXA_PARAMETERS WHERE PARAMETER_NAME = 'SQL_PREPROCESSOR_SCRIPT'").fetchval()
    with as_user("CREDORA_RM_AI") as ai:
        assert cifs(ai, "CREDORA.V_RM_DECISIONS") == rm1, "the AI session user sees exactly its person's book"
        assert cifs(ai, "CREDORA.V_LATEST_DECISION") == rm1
        assert refused(ai, "SELECT COUNT(*) FROM CREDORA.DECISIONS")
        print("   CREDORA_RM_AI sees the same 25 companies")
    with as_user("CREDORA_RM002") as rm002:
        assert cifs(rm002, "CREDORA.V_RM_DECISIONS") == rm2
        assert cifs(rm002, "CREDORA.V_LATEST_DECISION") == rm2
        assert count(rm002, "CREDORA.V_RM_LOAN_STATUS") == 5
        assert refused(rm002, "SELECT COUNT(*) FROM CREDORA.DECISIONS")
        print(f"   CREDORA_RM002 sees its {len(rm2)} companies and none of CREDORA_RM's")

    # A run that is not published stays invisible, even for an assigned company.
    with as_user("CREDORA_SVC") as svc:
        svc.execute(f"""INSERT INTO CREDORA.DECISIONS
                        SELECT '{DRAFT}', APP_ID, CIF_ID, LEGAL_NAME, RM_ID, PRODUCT, AMOUNT_REQUESTED, TENURE_REQUESTED,
                               DECISION, HARD_FAILS, GRADE, PD, OFFER_AMOUNT, OFFER_ROI, OFFER_TENURE, FLOOR_ROI, MAX_AMOUNT,
                               MAX_TENURE, RAROC_OFFER, RAROC_FLOOR, RANK_NO, SKYLINE_LAYER, TOP50, DECIDED_AT
                        FROM CREDORA.DECISIONS WHERE RUN_ID = '{RUN}'""")
    with as_user("CREDORA_RM") as rm:
        assert count(rm, "CREDORA.V_RM_DECISIONS") == 25, "a draft run is not shown"
    with as_user("CREDORA_LOANOPS") as ops:
        assert count(ops, "CREDORA.DECISIONS") == 100 and count(ops, "CREDORA.V_LATEST_DECISION") == 50
        assert count(ops, "CREDORA.V_COMPANY_MASKED") == 50
        assert refused(ops, "SELECT COUNT(*) FROM CREDORA_STAGE.GST_FILING"), "loan operations never reads raw 3rd party data"
        print("   CREDORA_LOANOPS sees all 50 companies of the published run and no raw 3rd party data")
    with as_user("CREDORA_MCP") as mcp:
        masked = mcp.execute("SELECT PAN_MASKED, GSTIN_MASKED FROM CREDORA.V_COMPANY_MASKED").fetchall()
        assert len(masked) == 50
        assert all(re.fullmatch(r"XXXXXX\d{3}A", p) and re.fullmatch(r"27XXXXXXXXXA1Z5", g) for p, g in masked), masked[:3]
        assert refused(mcp, "SELECT COUNT(*) FROM CREDORA.APPLICATIONS"), "the AI assistant user gets the masked view only"
        assert refused(mcp, "SELECT COUNT(*) FROM CREDORA_STAGE.CIBIL_CONSUMER")
        assert refused(mcp, "SELECT COUNT(*) FROM CREDORA.V_RM_DECISIONS")
        print("   CREDORA_MCP reads masked PAN and GSTIN only")
    with as_user("CREDORA_DATASCI") as ds:
        assert count(ds, "CREDORA_STAGE.GST_FILING") == 2400
        assert refused(ds, f"DELETE FROM CREDORA.RUN_PUBLISH WHERE RUN_ID = '{RUN}'"), "read-only"
    with as_user("CREDORA_ADMIN") as admin:
        assert count(admin, "EXA_DBA_USERS WHERE USER_NAME LIKE 'CREDORA%'") == len(es.ROLE_USERS)
        groups = dict(admin.execute("SELECT USER_NAME, USER_CONSUMER_GROUP FROM EXA_DBA_USERS WHERE USER_NAME LIKE 'CREDORA%'").fetchall())
        assert groups["CREDORA_SVC"] == "CREDORA_BATCH" and groups["CREDORA_RM"] == "CREDORA_APP", groups
        assert groups["CREDORA_RM_AI"] == "CREDORA_AI" and groups["CREDORA_MCP"] == "CREDORA_AI", groups
    with as_user("CREDORA_ADMIN_AI") as admin_ai:
        assert refused(admin_ai, "SELECT COUNT(*) FROM EXA_DBA_USERS"), "the admin's AI user reads no dictionary"
        assert count(admin_ai, "CREDORA.DECISIONS") == 100
    print("   CREDORA_ADMIN reads the dictionary, CREDORA_ADMIN_AI does not, consumer groups as 16_resources.sql sets them")

    say("Purge round trip as CREDORA_SVC: rows exist, PURGE_EXPIRED removes the expired ones, PURGE_LOG has the proof")
    with as_sys() as c:
        expected = expected_fingerprints(c)
        before = {t: count(c, f"CREDORA_STAGE.{t}") for t in PURGE_TARGETS}
        live = {t: count(c, f"CREDORA_STAGE.{t} WHERE PURGE_AT > SYSTIMESTAMP") for t in PURGE_TARGETS}
    assert set(expected) == {(f"CREDORA_STAGE.{t}", r) for t in PURGE_TARGETS for r in ("CI-RUN-0", RUN)}, expected.keys()
    assert expected[("CREDORA_STAGE.GST_FILING", "CI-RUN-0")][0] == 1200, "more than one chunk"
    assert before == {"CIBIL_CONSUMER": 200, "CIBIL_COMMERCIAL": 100, "GST_FILING": 2400, "AA_ACCOUNT": 200}, before
    with as_user("CREDORA_SVC") as svc:
        # An analysis in progress makes the purge wait for the next schedule.
        svc.execute("INSERT INTO CREDORA.RUN_LOG (RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS) "
                    "VALUES ('CI-RUN-2', 1, 'Refresh virtual schemas', 'OK', 3, 10)")
        out = svc.execute("EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()").fetchall()
        assert len(out) == 1 and out[0][3] == "SKIPPED" and out[0][1] == "CI-RUN-2", out
        assert {t: count(svc, f"CREDORA_STAGE.{t}") for t in PURGE_TARGETS} == before, "nothing purged while a run is in progress"
        svc.execute("DELETE FROM CREDORA.RUN_LOG WHERE RUN_ID = 'CI-RUN-2'")
        print("   skipped while an analysis was in progress, nothing deleted")
        out = svc.execute("EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()").fetchall()
        assert all(r[3] == "DELETED" for r in out), out
        got = {(f"CREDORA_STAGE.{t}", r): int(n) for t, r, n, _, _ in out}
        assert got == {k: v[0] for k, v in expected.items()}, (got, expected)
        after = {t: count(svc, f"CREDORA_STAGE.{t}") for t in PURGE_TARGETS}
        assert after == live, (after, live)
        assert all(count(svc, f"CREDORA_STAGE.{t} WHERE PURGE_AT <= SYSTIMESTAMP") == 0 for t in PURGE_TARGETS)
        proof = {(t, r): (int(n), h) for t, r, n, h in svc.execute(
            "SELECT TABLE_NAME, RUN_ID, ROWS_DELETED, SHA256 FROM CREDORA.PURGE_LOG").fetchall()}
        assert proof == expected, (proof, expected)
        assert all(re.fullmatch(r"[0-9a-f]{64}", h) for _, h in proof.values())
    deleted = sum(n for n, _ in expected.values())
    print(f"   {deleted} rows deleted over {len(expected)} table and run pairs, {sum(live.values())} within consent kept, "
          f"{len(proof)} PURGE_LOG rows match the recomputed fingerprints")

    with as_sys() as c:
        c.execute("DROP SCRIPT CREDORA.CI_DECIDE_AND_RANK")
    say(f"All checks passed in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
