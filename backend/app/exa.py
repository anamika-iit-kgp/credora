"""Exasol access: one small connection pool per database user, reused across requests.

Reads for a signed-in person go through the Exasol user of their role (so Exasol enforces what
they may see); jobs (analysis, training, CRM sync) use CREDORA_SVC.

Every session and statement is tagged "credora:<app user>:<feature>" so Exasol's own audit log
(EXA_DBA_AUDIT_SESSIONS.CLIENT and EXA_DBA_AUDIT_SQL.SQL_TEXT) shows which app user and which
screen or job ran it: the session's client name carries the tag it was opened for, and each
statement starts with a /*credora:...*/ comment carrying the current request's tag.
"""

from __future__ import annotations

import contextvars
import datetime as dt
import logging
import queue
import re
import ssl
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pyexasol

from . import console
from .config import settings

log = logging.getLogger("credora.exa")

ROLE_USER = {
    "admin": "CREDORA_ADMIN",
    "datasci": "CREDORA_DATASCI",
    "loanops": "CREDORA_LOANOPS",
    "rm": "CREDORA_RM",
}
SVC = "CREDORA_SVC"
LOGIN_OF = {u: login for login, u in ROLE_USER.items()}  # Exasol role user -> app login

_tz_lock = threading.Lock()
_db_tz: ZoneInfo | None = None

# (app user, feature) of the work in progress, when set explicitly (jobs, the purge fallback).
# Otherwise the request context of app/console.py decides: the signed-in person and the screen.
_tag: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("credora_exa_tag", default=None)


class ExaUnavailable(RuntimeError):
    """Exasol could not be reached."""


class ExaPoolBusy(ExaUnavailable):
    """Every pooled connection of this user stayed busy for the whole wait. Retrying at once would
    only wait again, so query() does not retry it. The API answers 503 like any ExaUnavailable."""


def _clean(part: str) -> str:
    return re.sub(r"[^a-z0-9_.-]+", "-", (part or "").lower()).strip("-")[:40] or "none"


def client_tag(app_user: str, feature: str) -> str:
    """'credora:<app user>:<feature>', safe inside a SQL comment and a client name."""
    return f"credora:{_clean(app_user)}:{_clean(feature)}"


def set_tag(app_user: str, feature: str) -> None:
    _tag.set((app_user, feature))


def current_tag() -> str:
    explicit = _tag.get()
    if explicit:
        return client_tag(*explicit)
    from . import console  # noqa: PLC0415 - console imports nothing from here

    c = console.current()
    return client_tag(c.username or "system", c.label or "api")


@contextmanager
def tagged(app_user: str, feature: str) -> Iterator[None]:
    token = _tag.set((app_user, feature))
    try:
        yield
    finally:
        _tag.reset(token)


def tag_sql(sql: str) -> str:
    """Prefix a statement with the current tag, as a comment Exasol keeps in EXA_DBA_AUDIT_SQL."""
    return f"/*{current_tag()}*/ {sql}"


def dsn() -> str:
    """host[/fingerprint]:port. With a fingerprint, pyexasol pins Exasol's self-signed certificate:
    a server presenting any other certificate is refused."""
    fp = f"/{settings.exasol_fingerprint}" if settings.exasol_fingerprint else ""
    return f"{settings.exasol_host}{fp}:{settings.exasol_port}"


def ssl_options() -> dict | None:
    # With a pinned fingerprint pyexasol checks the certificate itself (websocket_sslopt must stay
    # None); without one, the self-signed certificate cannot be validated, so it is not checked.
    return None if settings.exasol_fingerprint else {"cert_reqs": ssl.CERT_NONE}


def _connect(user: str, client: str | None = None) -> pyexasol.ExaConnection:
    try:
        return pyexasol.connect(
            dsn=dsn(),
            user=user,
            password=settings.exa_passwords.get(user, ""),
            encryption=True,
            websocket_sslopt=ssl_options(),
            compression=True,
            fetch_mapper=pyexasol.exasol_mapper,
            connection_timeout=10,
            socket_timeout=300,
            # Pooled sessions serve one app login each (the role user's); jobs pass their own tag.
            client_name=client or client_tag(LOGIN_OF.get(user, "system"), "web"),
            client_version="1",
            client_os_username="credora-backend",
        )
    except pyexasol.ExaError as e:  # pragma: no cover - network
        raise ExaUnavailable(f"Exasol is not reachable as {user}: {e.message if hasattr(e, 'message') else e}") from e


class _Pool:
    wait_s = 120.0  # how long a request waits for a busy pool before it gives up with ExaPoolBusy

    def __init__(self, user: str, size: int):
        self.user = user
        self.size = size
        self.idle: queue.LifoQueue[pyexasol.ExaConnection] = queue.LifoQueue()
        self.created = 0
        self.lock = threading.Lock()

    def acquire(self) -> pyexasol.ExaConnection:
        try:
            return self.idle.get_nowait()
        except queue.Empty:
            pass
        with self.lock:
            if self.created < self.size:
                self.created += 1
                try:
                    return _connect(self.user)
                except Exception:
                    self.created -= 1
                    raise
        try:
            return self.idle.get(timeout=self.wait_s)
        except queue.Empty:
            raise ExaPoolBusy("Exasol connection pool busy, try again") from None

    def release(self, conn: pyexasol.ExaConnection, broken: bool = False) -> None:
        if broken or conn.is_closed:
            with self.lock:
                self.created -= 1
            try:
                conn.close(disconnect=False)
            except Exception:  # noqa: BLE001
                pass
            return
        self.idle.put(conn)


_pools: dict[str, _Pool] = {}
_pools_lock = threading.Lock()


def _pool(user: str) -> _Pool:
    with _pools_lock:
        if user not in _pools:
            _pools[user] = _Pool(user, settings.exa_pool_size)
        return _pools[user]


@contextmanager
def connection(user: str) -> Iterator[pyexasol.ExaConnection]:
    pool = _pool(user)
    conn = pool.acquire()
    broken = False
    try:
        yield conn
    except pyexasol.ExaCommunicationError:
        broken = True
        raise
    except pyexasol.ExaRequestError as e:
        broken = conn.is_closed or "closed" in str(e).lower()
        raise
    finally:
        pool.release(conn, broken)


def query(user: str, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run one statement and return rows as dicts with JSON-friendly values.

    `params` are substituted by pyexasol's formatter: {name} is a quoted, escaped string literal,
    {name!d} a decimal, {name!f} a float.
    """
    db_timezone()  # resolve once, before holding a pooled connection
    for attempt in (1, 2):
        try:
            with connection(user) as conn:
                tagged_sql = tag_sql(sql)
                t0 = time.perf_counter()
                try:
                    st = conn.execute(tagged_sql, query_params=params) if params else conn.execute(tagged_sql)
                    if st.result_type != "resultSet":
                        out = [{"ROWS_AFFECTED": st.rowcount()}]
                        n = st.rowcount()
                    else:
                        cols = st.column_names()
                        out = [{c: to_json(v) for c, v in zip(cols, row)} for row in st]
                        n = len(out)
                except Exception as e:
                    _trace(conn, user, sql, params, t0, None, e)
                    raise
                _trace(conn, user, sql, params, t0, n)
                return out
        except ExaPoolBusy:
            raise
        except (pyexasol.ExaCommunicationError, ExaUnavailable):
            if attempt == 2:
                raise
            log.warning("Exasol connection for %s lost; reconnecting", user)
        except pyexasol.ExaRequestError as e:
            if attempt == 2 or "closed" not in str(e).lower():
                raise
    return []  # unreachable


def scalar(user: str, sql: str, params: dict[str, Any] | None = None) -> Any:
    rows = query(user, sql, params)
    return next(iter(rows[0].values())) if rows else None


def _trace(conn: Any, user: str, sql: str, params: dict[str, Any] | None, t0: float, rows: int | None,
           error: BaseException | None = None) -> None:
    """Record a statement for the Explain-mode Exasol console (app/console.py), with the parameters
    filled in as Exasol received them. Never raises."""
    try:
        shown = sql
        if params:
            try:
                shown = conn.format.format(sql, **params)
            except Exception:  # noqa: BLE001
                pass
        console.statement(user, shown, (time.perf_counter() - t0) * 1000, rows, error)
    except Exception:  # noqa: BLE001
        pass


def traced_execute(conn: Any, user: str, sql: str, params: dict[str, Any] | None = None):
    """conn.execute on a dedicated job connection, recorded in the Exasol console like `query`."""
    t0 = time.perf_counter()
    try:
        st = conn.execute(sql, query_params=params) if params else conn.execute(sql)
    except Exception as e:
        _trace(conn, user, sql, params, t0, None, e)
        raise
    try:
        n = st.rowcount()
    except Exception:  # noqa: BLE001
        n = None
    _trace(conn, user, sql, params, t0, n)
    return st


def new_connection(user: str = SVC) -> pyexasol.ExaConnection:
    """A dedicated connection for long-running jobs; the caller closes it. Its session carries the
    current tag (a job sets it to the app user who started it and the job kind)."""
    return _connect(user, current_tag())


def db_timezone() -> ZoneInfo:
    global _db_tz
    with _tz_lock:
        if _db_tz is None:
            try:
                with connection(SVC) as conn:
                    name = conn.execute("SELECT DBTIMEZONE FROM DUAL").fetchval()
                _db_tz = ZoneInfo(_tz_name(str(name)))
            except Exception:  # noqa: BLE001
                log.exception("could not read DBTIMEZONE; assuming UTC")
                return ZoneInfo("UTC")
        return _db_tz


def _tz_name(exa_name: str) -> str:
    # Exasol reports names like EUROPE/BERLIN; IANA names are case-sensitive.
    if exa_name.upper() in ("UTC", "GMT"):
        return "UTC"
    return "/".join(p.capitalize() if p.isalpha() else "_".join(w.capitalize() for w in p.split("_"))
                    for p in exa_name.lower().split("/"))


def iso_utc(v: dt.datetime | None) -> str | None:
    """Exasol TIMESTAMP values are naive, in the database time zone. Return ISO 8601 in UTC."""
    if v is None:
        return None
    if v.tzinfo is None:
        v = v.replace(tzinfo=db_timezone())
    return v.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def to_json(v: Any) -> Any:
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() and v.as_tuple().exponent >= 0 else float(v)
    if isinstance(v, dt.datetime):
        return iso_utc(v)
    if isinstance(v, dt.date):
        return v.isoformat()
    return v


def close_all() -> None:
    with _pools_lock:
        for p in _pools.values():
            while True:
                try:
                    c = p.idle.get_nowait()
                except queue.Empty:
                    break
                try:
                    c.close()
                except Exception:  # noqa: BLE001
                    pass
        _pools.clear()
