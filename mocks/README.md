# Credora mocks

Synthetic data for Sapphire Bank and three mock 3rd party data APIs. All data is fake.

| Service | Port | What it does |
|---|---|---|
| `generator` | 8100 | Clears and regenerates all bank and mock data (`POST /generate`) |
| `cibil` | 8101 | Mock CIBIL, with consumer reports (partners) and commercial reports (companies) |
| `gstn` | 8102 | Mock GSTN, with GST registrations and monthly returns |
| `aa` | 8103 | Mock Account Aggregator, with consent and other-bank accounts with transactions |

On AWS the three APIs sit behind HTTPS relays on the 3rd party data domain (`cibil.`, `gst.` and `aa.credora.link`, overview at https://credora.link). Exasol's Python UDFs fetch the 3rd party data from them on demand via API, with the `X-API-Key` header held in Exasol CONNECTION objects ([`exasol/udf/04_api_udfs.sql`](../exasol/udf/04_api_udfs.sql)).

Endpoints and JSON shapes are in [`docs/API.md`](../docs/API.md), tables and feature formulas in [`docs/DATA_MODEL.md`](../docs/DATA_MODEL.md), and the DDL in [`db/`](../db).

## Where the data goes

| Server | Databases / schema | Tables |
|---|---|---|
| Oracle | schema `CBS` | `ACCOUNT`, `TXN` |
| MySQL | `cif` | `rm`, `company`, `partner` |
| PostgreSQL (bank) | `los`, `crm` (schema `public`) | `application`, `past_loan`, `offer`, `offer_event` (the last two left empty) |
| PostgreSQL (mockdb) | `cibil`, `gstn`, `aa`, `truth` | see `db/mockdb.sql` |

A generation run creates missing users, databases and tables, truncates every table above, then loads about 1,000 companies, 3,500 partners, 830k Oracle transactions, 72k GST returns, 400k AA transactions and 5,000 past loans. It takes about 70 seconds on a laptop. Read-only users `CREDORA_RO` (Oracle), `credora_ro` (MySQL, PostgreSQL) get `SELECT` on the bank tables.

Each company has a hidden risk level that drives all of its data. The truth (`cif_id, true_pd, would_default`) goes to `truth.truth` on mockdb and, if `S3_BUCKET` is set, to `s3://$S3_BUCKET/truth/<job_id>.csv`. The same seed gives the same data on the same day.

## Environment

Mock APIs (`cibil`, `gstn`, `aa`).

| Variable | Notes |
|---|---|
| `MOCKDB_HOST`, `MOCKDB_PORT`, `MOCKDB_USER`, `MOCKDB_PASSWORD` | mockdb PostgreSQL server. Each mock reads its own database |
| `MOCK_API_TOKEN` | required value of the `X-API-Key` header |
| `WORKERS` (default 2), `POOL_SIZE` (default 10) | uvicorn workers, and DB connections per worker |

The generator uses the `MOCKDB_*` variables above, plus these.

| Variable | Notes |
|---|---|
| `ORACLE_HOST`, `ORACLE_PORT`, `ORACLE_SERVICE`, `ORACLE_USER`, `ORACLE_PASSWORD` | master user, creates users `CBS` and `CREDORA_RO` |
| `ORACLE_CBS_PASSWORD`, `ORACLE_RO_PASSWORD` | passwords set on `CBS` and `CREDORA_RO` |
| `ORACLE_TABLESPACE` | optional, default `USERS` |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_RO_PASSWORD` | master user, creates database `cif` and user `credora_ro` |
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_RO_PASSWORD` | master user, creates databases `los`, `crm` and role `credora_ro` |
| `S3_BUCKET` | optional, truth CSV upload with default AWS credentials |

## Run locally

```sh
cd mocks
docker compose -f docker-compose.dev.yml up -d --build      # Oracle takes 1-3 minutes to become healthy
curl -X POST localhost:8100/generate -H 'content-type: application/json' -d '{"seed": 42}'
curl localhost:8100/jobs/<job_id>                            # poll until status is "done"
curl localhost:8101/status
curl -H 'X-API-Key: dev-mock-token' localhost:8101/v1/commercial/<company PAN>
docker compose -f docker-compose.dev.yml down -v             # stop and delete all data
```

The dev stack publishes Oracle on 1521 (service `FREEPDB1`, master `system`), MySQL on 3306 (`root`), bank PostgreSQL on 5432 (`credora_admin`) and mockdb on 5433 (`mock`). Passwords are in `docker-compose.dev.yml` and are for local use only.

Without Docker, the generator also runs as a command once the variables are set, with `cd mocks/generator && python -m generator --seed 42`.
