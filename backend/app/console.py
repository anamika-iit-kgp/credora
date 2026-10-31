"""Exasol console: what the backend just ran in Exasol, shown live in the browser (Explain mode).

Every statement that goes through `exa.query` / `exa.traced_execute` is recorded here with the Exasol
user it ran as, its time, its row count and any error, tagged with the signed-in person and the
screen or action that caused it. Background jobs add their step events (RUN_LOG steps, model
registry switches), and Ask Credora adds each MCP tool call with its SQL.

Each signed-in person (one per role) has a small ring buffer of the latest entries; the browser
asks only for its own (`GET /api/exasol/console`). Statements run without a signed-in person
(the purge loop, start-up checks) go to a system buffer that only the admin may read.

Nothing secret is kept: configured passwords, keys and tokens are replaced, and string literals
that look like credentials are masked before an entry is stored.
"""

from __future__ import annotations

import contextvars
import datetime as dt
import itertools
import json
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .config import settings

MAX_PER_USER = 200
MAX_SQL_CHARS = 6000
REPEAT_WINDOW_S = 15.0  # the same statement again within this window bumps a counter instead
SESSION_HEADER = "x-credora-session"

# ---------------------------------------------------------------- request context


@dataclass(frozen=True)
class Ctx:
    username: str | None = None
    role: str | None = None
    session: str | None = None
    label: str | None = None


_ctx: contextvars.ContextVar[Ctx] = contextvars.ContextVar("credora_console", default=Ctx())


def current() -> Ctx:
    return _ctx.get()


def bind(**kw: Any) -> contextvars.Token:
    """Set (part of) the context for the current task or thread; returns a token for `unbind`."""
    c = _ctx.get()
    return _ctx.set(Ctx(**{**c.__dict__, **{k: v for k, v in kw.items() if k in Ctx.__dataclass_fields__}}))


def unbind(token: contextvars.Token) -> None:
    _ctx.reset(token)


_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")

# Path pattern -> what the person was doing, for the console's "feature" column.
_LABELS: list[tuple[str, re.Pattern[str], str]] = [(m, re.compile(p), label) for m, p, label in [
    ("POST", r"^/api/auth/login$", "Sign in"),
    ("GET", r"^/api/overview$", "Overview"),
    ("GET", r"^/api/companies$", "Data explorer"),
    ("GET", r"^/api/companies/[^/]+/tree$", "Company tree"),
    ("GET", r"^/api/nodes/", "Company records"),
    ("GET", r"^/api/companies/[^/]+/report$", "Exasol report"),
    ("*", r"^/api/companies/[^/]+/memo$", "Credit memo"),
    ("POST", r"^/api/analysis/run$", "Run analysis"),
    ("POST", r"^/api/runs/[^/]+/publish$", "Publish run"),
    ("GET", r"^/api/runs", "Analysis runs"),
    ("GET", r"^/api/decisions", "Decisions"),
    ("GET", r"^/api/top50", "Top 50"),
    ("POST", r"^/api/ml/train$", "Train models"),
    ("GET", r"^/api/ml/models", "Risk models"),
    ("GET", r"^/api/ml/compare", "Champion vs challenger"),
    ("*", r"^/api/ml/activation-requests", "Model activation"),
    ("*", r"^/api/whatif", "What-if"),
    ("*", r"^/api/policy", "Policy"),
    ("*", r"^/api/approvals", "Approvals"),
    ("*", r"^/api/assignments", "RM assignment"),
    ("*", r"^/api/rms", "Relationship managers"),
    ("*", r"^/api/loan-status", "Loan status"),
    ("POST", r"^/api/offers/[^/]+/quote$", "Negotiation quote"),
    ("*", r"^/api/offers", "Offers"),
    ("*", r"^/api/ai/ask$", "Ask Credora"),
    ("*", r"^/api/admin/sources", "Sources"),
    ("*", r"^/api/admin/audit", "Audit"),
    ("*", r"^/api/admin/purge", "Purge"),
    ("*", r"^/api/admin/generate", "Generate data"),
    ("*", r"^/api/exasol/control-room", "Exasol control room"),
]]


def feature_label(method: str, path: str) -> str:
    for m, rx, label in _LABELS:
        if (m == "*" or m == method) and rx.search(path):
            return label
    return f"{method} {path}"


class ConsoleMiddleware:
    """Pure ASGI middleware: binds the signed-in person, the browser session and the feature label
    to the request's context, so every Exasol statement made while serving it is attributed."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        username = role = None
        auth = headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            try:
                from .auth import decode_token  # noqa: PLC0415 - auth imports config only

                u = decode_token(auth[7:].strip())
                username, role = u.username, u.role
            except Exception:  # noqa: BLE001 - the route itself answers 401
                pass
        session = headers.get(SESSION_HEADER) or None
        if session and not _SESSION_RE.match(session):
            session = None
        token = _ctx.set(Ctx(username=username, role=role, session=session,
                             label=feature_label(scope.get("method", "GET"), scope["path"])))
        try:
            await self.app(scope, receive, send)
        finally:
            _ctx.reset(token)


# ---------------------------------------------------------------- redaction

_IDENT_BY = re.compile(r"(?i)(\bIDENTIFIED\s+BY\s+)('(?:[^']|'')*'|\"[^\"]*\")")
_CONN_DEF = re.compile(r"(?is)\b(CREATE|ALTER)\s+(OR\s+REPLACE\s+)?CONNECTION\b")
_CONN_PARTS = re.compile(r"(?i)(\b(?:TO|USER)\s+)('(?:[^']|'')*')")
_LITERAL = re.compile(r"'((?:[^']|'')*)'")
_SECRET_WORD = re.compile(r"(?i)(password|passwd|pwd=|secret|token|api[_-]?key|bearer\s|authorization)")
_SECRET_PREFIX = re.compile(r"^(sk-|AKIA|ASIA|eyJ|ghp_|xox[bp]-)")


def _known_secrets() -> list[str]:
    vals = [*settings.exa_passwords.values(), *settings.app_passwords.values(), settings.exa_mcp_password,
            settings.anthropic_api_key, settings.app_secret, settings.mock_api_token, settings.pg_password]
    return sorted({v for v in vals if v and len(v) >= 6}, key=len, reverse=True)


def _looks_secret(s: str) -> bool:
    if not s:
        return False
    if _SECRET_WORD.search(s) or _SECRET_PREFIX.match(s):
        return True
    if "://" in s and "@" in s.split("://", 1)[1]:
        return True  # credentials in a URL
    if len(s) >= 20 and not re.search(r"[\s/.,:]", s):
        classes = sum(bool(re.search(p, s)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]"))
        if classes == 3:
            return True  # long mixed-case alphanumeric token
    return False


def redact(text: str | None) -> str | None:
    if not text:
        return text
    out = text
    for secret in _known_secrets():
        out = out.replace(secret, "***")
    out = _IDENT_BY.sub(lambda m: m.group(1) + "'***'", out)
    if _CONN_DEF.search(out):
        out = _CONN_PARTS.sub(lambda m: m.group(1) + "'***'", out)
    out = _LITERAL.sub(lambda m: "'***'" if _looks_secret(m.group(1)) else m.group(0), out)
    return out


# ---------------------------------------------------------------- the buffers


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Entry:
    id: int
    seq: int
    at: str
    kind: str  # sql | step | mcp | event
    exa_user: str | None
    username: str | None
    role: str | None
    session: str | None
    label: str | None
    sql: str | None = None
    text: str | None = None
    ms: float | None = None
    rows: int | None = None
    error: str | None = None
    repeat: int = 1
    via: str | None = None
    tool: str | None = None
    objects: list[str] = field(default_factory=list)
    _mono: float = 0.0

    def view(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if not k.startswith("_")}
        if d["ms"] is not None:
            d["ms"] = round(float(d["ms"]), 1)
        return d


_lock = threading.Lock()
_ids = itertools.count(1)
_seq = itertools.count(1)
_buffers: dict[str, deque[Entry]] = {}
_system: deque[Entry] = deque(maxlen=MAX_PER_USER)


def _buffer(username: str | None) -> deque[Entry]:
    if not username:
        return _system
    b = _buffers.get(username)
    if b is None:
        b = _buffers[username] = deque(maxlen=MAX_PER_USER)
    return b


def _clip(s: str | None, n: int = MAX_SQL_CHARS) -> str | None:
    if s is None:
        return None
    s = s.strip()
    return s if len(s) <= n else s[:n] + f"\n-- … {len(s) - n:,} more characters"


def _error_text(e: BaseException | str | None) -> str | None:
    if e is None:
        return None
    msg = str(getattr(e, "message", None) or e).strip()
    msg = msg.split(" (Session:")[0].strip().splitlines()[0] if msg else type(e).__name__
    return redact(msg[:400])


def _add(kind: str, *, exa_user: str | None = None, sql: str | None = None, text: str | None = None,
         ms: float | None = None, rows: int | None = None, error: BaseException | str | None = None,
         via: str | None = None, tool: str | None = None, objects: list[str] | None = None) -> Entry:
    c = _ctx.get()
    sql = redact(_clip(sql))
    text = redact(text)
    err = _error_text(error)
    mono = time.monotonic()
    with _lock:
        buf = _buffer(c.username)
        if kind == "sql":
            # A poll (e.g. RUN_LOG every 0.8 s) becomes one entry with a repeat count.
            for last in list(buf)[-6:]:
                if (last.kind == "sql" and last.sql == sql and last.exa_user == exa_user
                        and last.session == c.session and last.error == err
                        and mono - last._mono < REPEAT_WINDOW_S):
                    last.repeat += 1
                    last.seq, last.at, last.ms, last.rows, last._mono = next(_seq), _now(), ms, rows, mono
                    return last
        e = Entry(id=next(_ids), seq=next(_seq), at=_now(), kind=kind, exa_user=exa_user, username=c.username,
                  role=c.role, session=c.session, label=c.label, sql=sql, text=text, ms=ms, rows=rows, error=err,
                  via=via, tool=tool, objects=list(objects or []), _mono=mono)
        buf.append(e)
        return e


def statement(exa_user: str, sql: str, ms: float, rows: int | None = None,
              error: BaseException | str | None = None) -> None:
    """One SQL statement the backend ran in Exasol."""
    try:
        _add("sql", exa_user=exa_user, sql=sql, ms=ms, rows=rows, error=error)
    except Exception:  # noqa: BLE001 - the console must never break a query
        pass


def step(text: str, *, exa_user: str | None = None, ms: float | None = None, rows: int | None = None,
         error: str | None = None, objects: list[str] | None = None) -> None:
    """A job step event, e.g. 'RUN_ANALYSIS step 7/13 Compute features, 10.8 s'."""
    try:
        _add("step", exa_user=exa_user, text=text, ms=ms, rows=rows, error=error, objects=objects)
    except Exception:  # noqa: BLE001
        pass


def event(text: str, *, exa_user: str | None = None, objects: list[str] | None = None) -> None:
    """Something Exasol-relevant that is not a statement, e.g. 'MODEL_REGISTRY.IS_ACTIVE switched to v4'."""
    try:
        _add("event", exa_user=exa_user, text=text, objects=objects)
    except Exception:  # noqa: BLE001
        pass


MCP_VIA = "Claude → exasol-mcp-server (EC2 app host) → Exasol as {user}"


def mcp_call(tool: str, args: dict | None, exa_user: str, ms: float, is_error: bool = False,
             error: str | None = None) -> None:
    """One Ask Credora tool call through the Exasol MCP server."""
    try:
        args = args or {}
        sql = args.get("query") or args.get("sql")
        if not sql:
            sql = "-- " + tool + " " + json.dumps(args, default=str)[:800]
        _add("mcp", exa_user=exa_user, sql=str(sql), ms=ms, tool=tool, via=MCP_VIA.format(user=exa_user),
             error=(error or "tool call failed") if is_error else None)
    except Exception:  # noqa: BLE001
        pass


def run_log_steps(run_id: str, rows: list[dict], total: int, seen: set[int] | None = None,
                  names: list[str] | None = None) -> None:
    """RUN_LOG rows of an analysis as step events, in step order. With `seen`, only steps not yet
    reported are added (RUN_ANALYSIS commits each step, so a poll sees them one by one)."""
    for r in sorted(rows, key=lambda r: int(r.get("STEP_NO") or 0)):
        no = int(r.get("STEP_NO") or 0)
        if seen is not None:
            if no in seen:
                continue
            seen.add(no)
        ms = float(r.get("MS") or 0)
        ok = r.get("STATUS") == "OK"
        name = r.get("STEP_NAME") or (names[no - 1] if names and 0 < no <= len(names) else "")
        step(f"RUN_ANALYSIS step {no}/{total} {name} "
             f"{'committed' if ok else 'failed'} in {ms / 1000:.1f} s",
             exa_user="CREDORA_SVC", ms=ms, rows=int(r["ROWS_OUT"]) if r.get("ROWS_OUT") is not None else None,
             error=None if ok else str(r.get("DETAIL") or "failed")[:300], objects=["CREDORA.RUN_LOG", run_id])


def entries(username: str, session: str | None = None, since: int = 0, everyone: bool = False) -> list[dict]:
    """The caller's entries newer than `since` (sequence numbers), oldest first.

    `session` narrows to one browser session, plus entries with no session (none are made for a
    signed-in person, but kept for safety). `everyone` (admin only) returns every person's
    entries and the system buffer."""
    with _lock:
        if everyone:
            pool = [e for b in [*_buffers.values(), _system] for e in b]
        else:
            pool = [e for e in _buffers.get(username, ()) if not session or e.session in (session, None)]
        out = [e.view() for e in pool if e.seq > since]
    out.sort(key=lambda d: d["seq"])
    return out[-MAX_PER_USER:]


def last_seq() -> int:
    with _lock:
        seqs = [b[-1].seq for b in [*_buffers.values(), _system] if b]
    return max(seqs, default=0)


def clear() -> None:
    """Tests only."""
    with _lock:
        _buffers.clear()
        _system.clear()
