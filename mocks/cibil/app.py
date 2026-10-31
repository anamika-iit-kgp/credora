"""Mock CIBIL bureau: consumer (partner) and commercial (company) credit reports."""

import os
import secrets
from contextlib import asynccontextmanager

import orjson
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from pydantic import BaseModel, Field

DB_NAME = "cibil"
MAX_BULK = 5000
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


app = FastAPI(title="Mock CIBIL", version="1.0", lifespan=lifespan)


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


CONSUMER_SQL = """
    SELECT pan, name, dob, score, report_date, enquiries_6m, enquiries_12m
    FROM consumer_report WHERE pan = ANY(%s::bpchar[])
"""
ACCOUNTS_SQL = """
    SELECT pan, lender, acct_type, opened_on, sanctioned, balance, overdue, status, dpd_36m
    FROM consumer_account WHERE pan = ANY(%s::bpchar[]) ORDER BY pan, opened_on
"""
COMMERCIAL_SQL = """
    SELECT pan, name, cmr_rank, report_date, total_exposure, overdue,
           suit_filed, wilful_default, facilities
    FROM commercial_report WHERE pan = ANY(%s::bpchar[])
"""


async def consumer_reports(pans: list[str]) -> list[dict]:
    reports = await fetch(CONSUMER_SQL, (pans,))
    if not reports:
        return []
    by_pan = {r["pan"]: {**r, "accounts": []} for r in reports}
    for acct in await fetch(ACCOUNTS_SQL, (list(by_pan),)):
        pan = acct.pop("pan")
        acct["dpd_36m"] = [int(v) for v in acct["dpd_36m"].split(",")] if acct["dpd_36m"] else []
        by_pan[pan]["accounts"].append(acct)
    return [by_pan[p] for p in pans if p in by_pan]


def normalise(pans: list[str]) -> list[str]:
    return list(dict.fromkeys(p.strip().upper() for p in pans))


class PanList(BaseModel):
    pans: list[str] = Field(max_length=MAX_BULK)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "cibil"}


@app.get("/status")
async def status() -> Response:
    rows = await fetch("""
        SELECT (SELECT generated_at FROM meta LIMIT 1) AS generated_at,
               (SELECT seed FROM meta LIMIT 1) AS seed,
               (SELECT count(*) FROM consumer_report) AS consumer_reports,
               (SELECT count(*) FROM commercial_report) AS commercial_reports
    """)
    return json_response(rows[0])


@app.get("/v1/consumer/{pan}", dependencies=[Depends(require_key)])
async def consumer(pan: str) -> Response:
    reports = await consumer_reports(normalise([pan]))
    if not reports:
        raise HTTPException(status_code=404, detail="PAN not found")
    return json_response(reports[0])


@app.post("/v1/consumer/bulk", dependencies=[Depends(require_key)])
async def consumer_bulk(body: PanList) -> Response:
    pans = normalise(body.pans)
    reports = await consumer_reports(pans)
    found = {r["pan"] for r in reports}
    return json_response({"reports": reports, "not_found": [p for p in pans if p not in found]})


@app.get("/v1/commercial/{pan}", dependencies=[Depends(require_key)])
async def commercial(pan: str) -> Response:
    rows = await fetch(COMMERCIAL_SQL, (normalise([pan]),))
    if not rows:
        raise HTTPException(status_code=404, detail="PAN not found")
    return json_response(rows[0])


@app.post("/v1/commercial/bulk", dependencies=[Depends(require_key)])
async def commercial_bulk(body: PanList) -> Response:
    pans = normalise(body.pans)
    by_pan = {r["pan"]: r for r in await fetch(COMMERCIAL_SQL, (pans,))}
    return json_response({
        "reports": [by_pan[p] for p in pans if p in by_pan],
        "not_found": [p for p in pans if p not in by_pan],
    })
