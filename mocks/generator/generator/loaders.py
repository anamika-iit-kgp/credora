"""Database access: schema setup, clearing and bulk loading for all four servers."""

import json
import os
from datetime import datetime, timezone
from itertools import islice
from typing import Callable, Iterable

import oracledb
import psycopg
import pymysql
from psycopg import sql

from . import ids, sqlfile

Progress = Callable[[float, str], None]
ORACLE_BATCH = 25_000
MYSQL_BATCH = 2_000
MOCK_DATABASES = ("cibil", "gstn", "aa", "truth")


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"environment variable {name} is not set")
    return value


def batched(rows: Iterable, size: int):
    it = iter(rows)
    while chunk := list(islice(it, size)):
        yield chunk


def oracle_ident_password(value: str) -> str:
    if '"' in value:
        raise ValueError("Oracle passwords must not contain double quotes")
    return f'"{value}"'


# ---------------------------------------------------------------- Oracle (CBS)

class Oracle:
    TABLES = ("ACCOUNT", "TXN")

    def __init__(self):
        self.dsn = f"{env('ORACLE_HOST')}:{env('ORACLE_PORT', '1521')}/{env('ORACLE_SERVICE')}"
        self.cbs_password = env("ORACLE_CBS_PASSWORD")
        self.ro_password = env("ORACLE_RO_PASSWORD")
        self.tablespace = env("ORACLE_TABLESPACE", "USERS")

    def master(self):
        return oracledb.connect(user=env("ORACLE_USER"), password=env("ORACLE_PASSWORD"), dsn=self.dsn)

    def cbs(self):
        return oracledb.connect(user="CBS", password=self.cbs_password, dsn=self.dsn)

    def _ensure_user(self, cur, user: str, password: str, privileges: str, quota: bool) -> None:
        cur.execute("SELECT COUNT(*) FROM all_users WHERE username = :u", u=user)
        pw = oracle_ident_password(password)
        if cur.fetchone()[0]:
            cur.execute(f"ALTER USER {user} IDENTIFIED BY {pw}")
        else:
            extra = f" DEFAULT TABLESPACE {self.tablespace} QUOTA UNLIMITED ON {self.tablespace}" if quota else ""
            cur.execute(f"CREATE USER {user} IDENTIFIED BY {pw}{extra}")
        cur.execute(f"GRANT {privileges} TO {user}")

    def prepare(self, truncate: bool = True) -> None:
        """Create users CBS and CREDORA_RO, create missing tables, empty them (replace mode),
        grant read access."""
        with self.master() as conn, conn.cursor() as cur:
            self._ensure_user(cur, "CBS", self.cbs_password, "CREATE SESSION, CREATE TABLE", quota=True)
            self._ensure_user(cur, "CREDORA_RO", self.ro_password, "CREATE SESSION", quota=False)
        with self.cbs() as conn, conn.cursor() as cur:
            for stmt in sqlfile.load("oracle_cbs.sql"):
                try:
                    cur.execute(stmt)
                except oracledb.DatabaseError as exc:
                    # ORA-00955 name already used, ORA-01408 column list already indexed
                    if exc.args[0].code not in (955, 1408):
                        raise
            for table in self.TABLES:
                if truncate:
                    cur.execute(f"TRUNCATE TABLE {table}")
                cur.execute(f"GRANT SELECT ON {table} TO CREDORA_RO")

    def existing(self) -> dict:
        """Account numbers in use and the last TXN_ID, for append mode."""
        with self.cbs() as conn, conn.cursor() as cur:
            cur.arraysize = 10_000
            accounts = {r[0] for r in cur.execute("SELECT ACCOUNT_NO FROM ACCOUNT")}
            last_txn = cur.execute("SELECT NVL(MAX(TXN_ID), 0) FROM TXN").fetchone()[0]
        return {"account_nos": accounts, "last_txn": int(last_txn)}

    def load(self, accounts: list[tuple], txns: Iterable[list], expected: int, progress: Progress) -> int:
        n = 0
        with self.cbs() as conn, conn.cursor() as cur:
            cur.executemany("INSERT INTO ACCOUNT VALUES (:1, :2, :3, :4, :5, :6, :7, :8)", accounts)
            cur.setinputsizes(None, 14, oracledb.DB_TYPE_DATE, 1, None, 6, 80, 120, None, 1)
            for chunk in batched(txns, ORACLE_BATCH):
                cur.executemany("INSERT INTO TXN VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10)", chunk)
                n += len(chunk)
                progress(min(n / expected, 0.99), f"{len(accounts):,} accounts, {n:,} transactions")
            conn.commit()
            cur.execute("BEGIN DBMS_STATS.GATHER_SCHEMA_STATS('CBS'); END;")
        return n

    def counts(self) -> dict:
        with self.cbs() as conn, conn.cursor() as cur:
            return {f"CBS.{t}": cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in self.TABLES}


# ---------------------------------------------------------------- MySQL (cif)

class MySQL:
    TABLES = ("rm", "company", "partner")

    def connect(self):
        return pymysql.connect(host=env("MYSQL_HOST"), port=int(env("MYSQL_PORT", "3306")),
                               user=env("MYSQL_USER"), password=env("MYSQL_PASSWORD"),
                               autocommit=True, charset="utf8mb4")

    def prepare(self, truncate: bool = True) -> None:
        with self.connect() as conn, conn.cursor() as cur:
            for stmt in sqlfile.load("mysql_cif.sql"):
                cur.execute(stmt)
            for table in self.TABLES if truncate else ():
                cur.execute(f"TRUNCATE TABLE cif.{table}")
            ro_password = env("MYSQL_RO_PASSWORD")
            cur.execute("CREATE USER IF NOT EXISTS 'credora_ro'@'%%' IDENTIFIED BY %s", (ro_password,))
            cur.execute("ALTER USER 'credora_ro'@'%%' IDENTIFIED BY %s", (ro_password,))
            cur.execute("GRANT SELECT ON cif.* TO 'credora_ro'@'%'")

    def existing(self) -> dict:
        """RMs, last CIF and partner ids, and the names, PANs and GSTINs in use, for append mode."""
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT rm_id, name, branch FROM cif.rm ORDER BY rm_id")
            rms = [tuple(r) for r in cur.fetchall()]
            cur.execute("SELECT cif_id, legal_name, pan, gstin FROM cif.company")
            companies = cur.fetchall()
            cur.execute("SELECT partner_id, name, pan FROM cif.partner")
            partners = cur.fetchall()
        return {
            "rms": rms,
            "last_cif": max((ids.number(r[0]) for r in companies), default=0),
            "last_partner": max((ids.number(r[0]) for r in partners), default=0),
            "company_names": {r[1] for r in companies},
            "person_names": {r[1] for r in partners},
            "pans": {r[2] for r in companies} | {r[2] for r in partners},
            "gstins": {r[3] for r in companies},
        }

    def load(self, data: dict[str, list[tuple]]) -> None:
        with self.connect() as conn, conn.cursor() as cur:
            for table, rows in data.items():
                if not rows:
                    continue
                marks = ", ".join(["%s"] * len(rows[0]))
                for chunk in batched(rows, MYSQL_BATCH):
                    cur.executemany(f"INSERT INTO cif.{table} VALUES ({marks})", chunk)

    def counts(self) -> dict:
        with self.connect() as conn, conn.cursor() as cur:
            out = {}
            for t in self.TABLES:
                cur.execute(f"SELECT COUNT(*) FROM cif.{t}")
                out[f"cif.{t}"] = cur.fetchone()[0]
            return out


# ---------------------------------------------------------------- PostgreSQL helpers

class PgServer:
    """One PostgreSQL server reached with a master user; databases are created on demand."""

    def __init__(self, prefix: str, admin_db: str = "postgres"):
        self.params = dict(host=env(f"{prefix}_HOST"), port=env(f"{prefix}_PORT", "5432"),
                           user=env(f"{prefix}_USER"), password=env(f"{prefix}_PASSWORD"))
        self.admin_db = admin_db

    def connect(self, dbname: str, autocommit: bool = False):
        return psycopg.connect(dbname=dbname, autocommit=autocommit, **self.params)

    def ensure_databases(self, names: Iterable[str]) -> None:
        with self.connect(self.admin_db, autocommit=True) as conn:
            existing = {r[0] for r in conn.execute("SELECT datname FROM pg_database")}
            for name in names:
                if name not in existing:
                    conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))

    @staticmethod
    def run(conn, statements: list[str]) -> None:
        for stmt in statements:
            conn.execute(stmt)

    @staticmethod
    def copy(conn, table: str, columns: list[str], rows: Iterable) -> int:
        n = 0
        stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(
            sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, columns)))
        with conn.cursor().copy(stmt) as cp:
            for row in rows:
                cp.write_row(row)
                n += 1
        return n

    @staticmethod
    def count(conn, table: str) -> int:
        return conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]


# ---------------------------------------------------------------- PostgreSQL bank (los, crm)

class BankPostgres:
    DATABASES = {"los": ("postgres_los.sql", ("application", "past_loan")),
                 "crm": ("postgres_crm.sql", ("offer", "offer_event"))}

    def __init__(self):
        self.server = PgServer("PG")

    def prepare(self, truncate: bool = True) -> None:
        self.server.ensure_databases(self.DATABASES)
        ro_password = env("PG_RO_PASSWORD")
        with self.server.connect(self.server.admin_db, autocommit=True) as conn:
            exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = 'credora_ro'").fetchone()
            verb = "ALTER" if exists else "CREATE"
            conn.execute(sql.SQL(verb + " ROLE credora_ro LOGIN PASSWORD {}").format(sql.Literal(ro_password)))
        for db, (ddl, tables) in self.DATABASES.items():
            with self.server.connect(db) as conn:
                self.server.run(conn, sqlfile.load(ddl))
                if truncate:
                    conn.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY").format(
                        sql.SQL(", ").join(map(sql.Identifier, tables))))
                conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO credora_ro").format(sql.Identifier(db)))
                conn.execute("GRANT USAGE ON SCHEMA public TO credora_ro")
                conn.execute("GRANT SELECT ON ALL TABLES IN SCHEMA public TO credora_ro")
                conn.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO credora_ro")

    def existing(self) -> dict:
        """Last application id and whether past loans exist, for append mode."""
        with self.server.connect("los") as conn:
            last_app, past = conn.execute(
                "SELECT max(app_id), (SELECT count(*) FROM past_loan) FROM application").fetchone()
        return {"last_app": ids.number(last_app), "has_past_loans": past > 0}

    def load(self, applications: list[tuple], past_loans: list[tuple]) -> None:
        with self.server.connect("los") as conn:
            self.server.copy(conn, "application", ["app_id", "cif_id", "applied_on", "product",
                             "amount_requested", "tenure_requested", "purpose", "collateral_type",
                             "collateral_value", "status"], applications)
            self.server.copy(conn, "past_loan", [
                "loan_id", "sanctioned_on", "product", "amount", "gst_years", "gst_turnover_12m",
                "gst_late_filings_12m", "gst_bank_gap_pct", "avg_balance_12m", "inflow_volatility",
                "bounce_ratio", "cmr_rank", "partner_min_score", "partner_avg_score",
                "partner_overdue_amt", "partner_other_bank_bal", "dscr", "defaulted"], past_loans)

    def counts(self) -> dict:
        out = {}
        for db, (_, tables) in self.DATABASES.items():
            with self.server.connect(db) as conn:
                out.update({f"{db}.{t}": self.server.count(conn, t) for t in tables})
        return out


# ---------------------------------------------------------------- mockdb (cibil, gstn, aa, truth)

class MockDb:
    TABLES = {
        "cibil": ("meta", "consumer_report", "consumer_account", "commercial_report"),
        "gstn": ("meta", "registration", "filing"),
        "aa": ("meta", "fi_account", "fi_txn", "consent"),
        "truth": ("meta", "truth"),
    }

    def __init__(self):
        self.server = PgServer("MOCKDB")

    def prepare(self, truncate: bool = True) -> None:
        self.server.ensure_databases(MOCK_DATABASES)
        sections = sqlfile.load_sections("mockdb.sql")
        for db in MOCK_DATABASES:
            with self.server.connect(db) as conn:
                self.server.run(conn, sections[db])
                if truncate:
                    conn.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY").format(
                        sql.SQL(", ").join(map(sql.Identifier, self.TABLES[db]))))

    def existing(self) -> dict:
        """PANs, GSTINs and AA account ids already held by the mock bureaus, for append mode."""
        out = {"pans": set(), "gstins": set(), "aa_ids": set()}
        with self.server.connect("cibil") as conn:
            out["pans"] |= {r[0] for r in conn.execute(
                "SELECT pan FROM consumer_report UNION SELECT pan FROM commercial_report")}
        with self.server.connect("gstn") as conn:
            for gstin, pan in conn.execute("SELECT gstin, pan FROM registration"):
                out["gstins"].add(gstin)
                out["pans"].add(pan)
        with self.server.connect("aa") as conn:
            out["aa_ids"] = {r[0] for r in conn.execute("SELECT aa_account_id FROM fi_account")}
        return out

    def counts(self) -> dict:
        out = {}
        for db, tables in self.TABLES.items():
            with self.server.connect(db) as conn:
                out.update({f"{db}.{t}": self.server.count(conn, t) for t in tables if t not in ("meta", "consent")})
        return out

    def load(self, db: str, tables: list[tuple[str, list[str], Iterable]], marker: tuple) -> dict:
        counts = {}
        with self.server.connect(db) as conn:
            for table, columns, rows in tables:
                counts[f"{db}.{table}"] = self.server.copy(conn, table, columns, rows)
            # one row: the latest generation (the mock APIs report it in /status)
            conn.execute("DELETE FROM meta")
            conn.execute("INSERT INTO meta (generated_at, seed, job_id) VALUES (%s, %s, %s)", marker)
        return counts

    def save_job(self, job: dict) -> None:
        with self.server.connect("truth") as conn:
            conn.execute("""
                INSERT INTO generation_job (job_id, seed, status, started_at, finished_at, seconds, counts, error)
                VALUES (%(job_id)s, %(seed)s, %(status)s, %(started_at)s, %(finished_at)s, %(seconds)s,
                        %(counts)s, %(error)s)
                ON CONFLICT (job_id) DO UPDATE SET status = EXCLUDED.status, finished_at = EXCLUDED.finished_at,
                    seconds = EXCLUDED.seconds, counts = EXCLUDED.counts, error = EXCLUDED.error
            """, {**job, "counts": json.dumps(job.get("counts") or {})})

    def last_job(self) -> dict | None:
        with self.server.connect("truth") as conn:
            cur = conn.cursor(row_factory=psycopg.rows.dict_row)
            cur.execute("SELECT * FROM generation_job ORDER BY finished_at DESC NULLS LAST LIMIT 1")
            return cur.fetchone()


def now() -> datetime:
    return datetime.now(timezone.utc)
