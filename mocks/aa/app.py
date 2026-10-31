"""Mock Account Aggregator: consent plus financial information from other banks."""

import os
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import orjson
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from pydantic import BaseModel, Field

DB_NAME = "aa"
MAX_BULK = 5000
CONSENT_TTL = timedelta(hours=24)
DEFAULT_PURPOSE = "Loan underwriting"
API_TOKEN = os.environ["MOCK_API_TOKEN"]

CONNINFO = psycopg.conninfo.make_conninfo(
    host=os.environ["MOCKDB_HOST"],
    port=os.environ.get("MOCKDB_PORT", "5432"),
    user=os.environ["MOCKDB_USER"],
    password=os.environ["MOCKDB_PASSWORD"],
    dbname=DB_NAME,
)
pool = AsyncConnectionPool(
    CONNINFO,
    min_size=2,
    max_size=int(os.environ.get("POOL_SIZE", "10")),
    kwargs={"row_factory": dict_row},
    timeout=10,
    open=False,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await pool.open(wait=False)
    yield
    await pool.close()


app = FastAPI(title="Mock Account Aggregator", version="1.0", lifespan=lifespan)


def json_response(payload, status_code: int = 200) -> Response:
    return Response(orjson.dumps(payload, default=float), status_code=status_code,
                    media_type="application/json")


def require_key(x_api_key: str | None = Header(default=None)) -> None:
    if not x_api_key or not secrets.compare_digest(x_api_key, API_TOKEN):
        raise HTTPException(status_code=401, detail="missing or invalid X-API-Key")


@app.exception_handler(psycopg.errors.UndefinedTable)
async def no_data(_: Request, __: Exception) -> Response:
    return json_response({"detail": "no data generated yet"}, 503)


@app.exception_handler(psycopg.OperationalError)
@app.exception_handler(PoolTimeout)
async def db_down(_: Request, __: Exception) -> Response:
    # also raised before the first generation, when the database does not exist yet
    return json_response({"detail": "mock database unavailable"}, 503)


async def fetch(sql: str, params=None) -> list[dict]:
    async with pool.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()


ACCOUNTS_SQL = """
    SELECT owner_pan, aa_account_id, fip, acct_type, masked_no, opened_on, current_balance
    FROM fi_account WHERE owner_pan = ANY(%s::bpchar[]) ORDER BY owner_pan, aa_account_id
"""
TXNS_SQL = """
    SELECT aa_account_id, txn_date, dr_cr, amount, narration, balance_after
    FROM fi_txn WHERE aa_account_id = ANY(%s) ORDER BY aa_account_id, txn_date DESC, id DESC
"""


async def accounts_for(pans: list[str]) -> dict[str, list]:
    """Accounts with their transactions (newest first), grouped by owner PAN."""
    out: dict[str, list] = {p: [] for p in pans}
    accounts = await fetch(ACCOUNTS_SQL, (pans,))
    if not accounts:
        return out
    by_id = {}
    for acct in accounts:
        acct["transactions"] = []
        by_id[acct["aa_account_id"]] = acct
        out[acct.pop("owner_pan")].append(acct)
    for txn in await fetch(TXNS_SQL, (list(by_id),)):
        by_id[txn.pop("aa_account_id")]["transactions"].append(txn)
    return out


async def create_consents(pans: list[str], purpose: str) -> list[dict]:
    now = datetime.now()
    consents = [{"consent_id": str(uuid.uuid4()), "pan": p, "purpose": purpose, "status": "ACTIVE",
                 "created_at": now, "expires_at": now + CONSENT_TTL} for p in pans]
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.executemany(
                "INSERT INTO consent (consent_id, pan, purpose, status, created_at, expires_at) "
                "VALUES (%(consent_id)s, %(pan)s, %(purpose)s, %(status)s, %(created_at)s, %(expires_at)s)",
                consents)
    return consents


def normalise(pans: list[str]) -> list[str]:
    return list(dict.fromkeys(p.strip().upper() for p in pans))


class ConsentRequest(BaseModel):
    pan: str = Field(min_length=10, max_length=10)
    purpose: str = Field(default=DEFAULT_PURPOSE, max_length=60)


class PanList(BaseModel):
    pans: list[str] = Field(max_length=MAX_BULK)
    purpose: str = Field(default=DEFAULT_PURPOSE, max_length=60)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "aa"}


@app.get("/status")
async def status() -> Response:
    rows = await fetch("""
        SELECT (SELECT generated_at FROM meta LIMIT 1) AS generated_at,
               (SELECT seed FROM meta LIMIT 1) AS seed,
               (SELECT count(*) FROM fi_account) AS accounts,
               (SELECT count(*) FROM fi_txn) AS transactions,
               (SELECT count(*) FROM consent) AS consents
    """)
    return json_response(rows[0])


@app.post("/v1/consent", dependencies=[Depends(require_key)])
async def consent(body: ConsentRequest) -> Response:
    c = (await create_consents(normalise([body.pan]), body.purpose))[0]
    return json_response({k: c[k] for k in ("consent_id", "pan", "status", "created_at", "expires_at")})


@app.get("/v1/fi/{consent_id}", dependencies=[Depends(require_key)])
async def fi(consent_id: str) -> Response:
    rows = await fetch("SELECT pan, status, expires_at FROM consent WHERE consent_id = %s", (consent_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="consent not found")
    c = rows[0]
    if c["status"] != "ACTIVE" or c["expires_at"] < datetime.now():
        raise HTTPException(status_code=403, detail="consent expired")
    accounts = await accounts_for([c["pan"]])
    return json_response({"consent_id": consent_id, "pan": c["pan"], "accounts": accounts[c["pan"]]})


@app.post("/v1/fi/bulk", dependencies=[Depends(require_key)])
async def fi_bulk(body: PanList) -> Response:
    pans = normalise(body.pans)
    consents = await create_consents(pans, body.purpose)
    accounts = await accounts_for(pans)
    return json_response({"items": [
        {"pan": c["pan"], "consent_id": c["consent_id"], "accounts": accounts[c["pan"]]}
        for c in consents
    ]})
