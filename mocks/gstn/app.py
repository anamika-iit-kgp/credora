"""Mock GSTN: GST registrations and monthly return filings."""

import os
import re
import secrets
from contextlib import asynccontextmanager

import orjson
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import Response
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from pydantic import BaseModel, Field

DB_NAME = "gstn"
MAX_BULK = 5000
API_TOKEN = os.environ["MOCK_API_TOKEN"]
PERIOD = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

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


app = FastAPI(title="Mock GSTN", version="1.0", lifespan=lifespan)


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


REGISTRATION_SQL = """
    SELECT r.gstin, r.legal_name, r.pan, r.state, r.registered_on, r.status,
           round((SELECT count(*) FROM filing f WHERE f.gstin = r.gstin) / 12.0, 1) AS years_of_filing
    FROM registration r WHERE r.gstin = ANY(%s::bpchar[])
"""
RETURNS_SQL = """
    SELECT gstin, period, gstr1_turnover, gstr3b_tax_paid, due_date, filed_on,
           CASE WHEN filed_on IS NULL THEN NULL ELSE greatest(filed_on - due_date, 0) END AS delay_days
    FROM filing
    WHERE gstin = ANY(%s::bpchar[]) AND period >= %s AND period <= %s
    ORDER BY gstin, period DESC
"""


def stage(years: float) -> str:
    if years < 5:
        return "New"
    if years < 8:
        return "Mid-level"
    return "Stable"


async def registrations(gstins: list[str]) -> dict[str, dict]:
    rows = await fetch(REGISTRATION_SQL, (gstins,))
    for r in rows:
        r["years_of_filing"] = float(r["years_of_filing"])
        r["stage"] = stage(r["years_of_filing"])
    return {r["gstin"]: r for r in rows}


async def returns(gstins: list[str], start: str | None, end: str | None) -> dict[str, list]:
    out: dict[str, list] = {g: [] for g in gstins}
    for row in await fetch(RETURNS_SQL, (gstins, start or "0000-00", end or "9999-99")):
        out[row.pop("gstin")].append(row)
    return out


def check_period(value: str | None) -> str | None:
    if value is not None and not PERIOD.match(value):
        raise HTTPException(status_code=422, detail="period must be YYYY-MM")
    return value


def normalise(gstins: list[str]) -> list[str]:
    return list(dict.fromkeys(g.strip().upper() for g in gstins))


class GstinList(BaseModel):
    gstins: list[str] = Field(max_length=MAX_BULK)
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "gstn"}


@app.get("/status")
async def status() -> Response:
    rows = await fetch("""
        SELECT (SELECT generated_at FROM meta LIMIT 1) AS generated_at,
               (SELECT seed FROM meta LIMIT 1) AS seed,
               (SELECT count(*) FROM registration) AS registrations,
               (SELECT count(*) FROM filing) AS filings
    """)
    return json_response(rows[0])


@app.get("/v1/gstin/{gstin}", dependencies=[Depends(require_key)])
async def gstin_detail(gstin: str) -> Response:
    regs = await registrations(normalise([gstin]))
    if not regs:
        raise HTTPException(status_code=404, detail="GSTIN not found")
    return json_response(next(iter(regs.values())))


@app.get("/v1/gstin/{gstin}/returns", dependencies=[Depends(require_key)])
async def gstin_returns(gstin: str, start: str | None = Query(default=None, alias="from"),
                        end: str | None = Query(default=None, alias="to")) -> Response:
    gstins = normalise([gstin])
    if not await registrations(gstins):
        raise HTTPException(status_code=404, detail="GSTIN not found")
    filings = await returns(gstins, check_period(start), check_period(end))
    return json_response({"gstin": gstins[0], "returns": filings[gstins[0]]})


@app.post("/v1/returns/bulk", dependencies=[Depends(require_key)])
async def returns_bulk(body: GstinList) -> Response:
    gstins = normalise(body.gstins)
    regs = await registrations(gstins)
    found = [g for g in gstins if g in regs]
    filings = await returns(found, check_period(body.from_), check_period(body.to)) if found else {}
    items = [{"gstin": g, "registration": regs[g], "returns": filings[g]} for g in found]
    return json_response({"items": items, "not_found": [g for g in gstins if g not in regs]})
