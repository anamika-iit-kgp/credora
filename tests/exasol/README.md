# Credora's Exasol SQL on a throwaway Exasol

GitHub Actions runs `run_docker_db.py` against `exasol/docker-db` on every push and pull request (the workflow is `.github/workflows/exasol.yml`, the job is "Exasol SQL on docker-db"). It applies the SQL, Lua and UDF files of `exasol/` in the order of `deploy/credora.py`, through the same `deploy/sql_runner.py`, on the Exasol version the live deployment runs. It then loads one analysis run of 50 synthetic companies, lets the real decision SQL and the `PREFERRING` ranking decide them, seeds the relationship manager's book and checks as each Exasol user what Exasol lets it read. The purge runs last and its proof is recomputed.

## What runs

- `exasol/sql/01_schemas.sql`, `02_connections.sql` (with placeholder hosts and passwords, a `CONNECTION` connects to nothing when it is created), the Python UDFs in `exasol/udf/`, the Lua scripts in `exasol/lua/`, `07_security.sql`, `13_rm_row_security.sql`, `16_resources.sql`, `17_scheduler.sql`, `exasol/semantic/11_latest_run_views.sql`, `15_comments.sql` and `14_seed_rm_book.sql`.
- The roles, users and consumer groups come from `deploy/exasol_setup.py`, as on a deployment. The passwords are made for the run and never stored.
- The SQL preprocessing, through the same functions of `deploy/exasol_setup.py`. The preprocessor framework is installed from its pinned release (the SHA-256 is checked), put in the system slot, and the two preprocessor-library modules are installed for the roles that send AI-written SQL. `CREDORA_RM`'s session is then checked to run through the framework's pipeline, which rewrites a cast shorthand and a trailing comma, while a deploy session, with the preprocessor off, refuses the same statement.
- `fixtures.sql` writes the run as `CREDORA_SVC`. It holds what steps 2 to 10 of `RUN_ANALYSIS` would have produced for 50 companies, with values that are arithmetic on the company number, so the run is the same everywhere. The staging tables get rows whose purge time has passed and rows still within consent, and an older run that has expired as a whole.
- `ci_scripts.sql` holds one test-only Lua script that is steps 11 and 12 of `RUN_ANALYSIS` on their own. It is dropped at the end.

## What is skipped, and why

- `exasol/sql/03_virtual_schemas.sql`. The virtual schemas need the Oracle adapter, the adbc-vs-rs Rust adapter and the three RDS databases. Three empty schemas with the same names stand in, so the grants in `07_security.sql` resolve.
- `exasol/extensions/10_semantic_views_module.sql` and `exasol/semantic/12_credora_model.sql`. They need exasol-semantic-views, which its own release installer puts in place on a deployment.
- The full `RUN_ANALYSIS`. Its first ten steps read the virtual schemas, call the API UDFs and load a model file from BucketFS. The fixture rows stand in for their output.

The runner compares its own list with the file names in `deploy/credora.py`. A SQL file added to the deploy tool fails this job until it is applied or listed as skipped here.

## What is checked

- Every file applies without an error, and every view in `CREDORA` compiles.
- The decision SQL gives 39 pre-approved offers, 6 referrals and 5 declines for the fixture run, each for the reason the fixtures were built to trigger, and every offer lies within the credit need on file and at or above the floor rate. The Top 50 is the 39 approved companies, ranked 1 to 39.
- `CREDORA_RM` sees exactly the 25 companies the seed assigned to it through every `V_RM_*` and `V_LATEST_*` view, with full PAN and GSTIN, and Exasol refuses it a direct `SELECT` on `CREDORA.DECISIONS`, `SCORES`, `FEATURES`, `APPLICATIONS`, `V_COMPANY_MASKED`, `ANOMALY`, `RM_ASSIGNMENT` and the staging tables.
- `CREDORA_RM_AI` sees the same 25 companies as its person. `CREDORA_RM002` sees its own 5 and none of the other book. A run that is not published is invisible to both.
- `CREDORA_LOANOPS` sees all 50 companies and no raw 3rd party data. `CREDORA_MCP` reads masked PAN and GSTIN only. `CREDORA_DATASCI` cannot write. `CREDORA_ADMIN` reads the dictionary and `CREDORA_ADMIN_AI` does not. The consumer groups are as `16_resources.sql` sets them. `CREDORA_SVC` cannot create a table.
- The purge. `PURGE_EXPIRED`, run as `CREDORA_SVC`, skips while a run is in progress. It then deletes exactly the expired rows of each staging table and run, keeps the rows within consent, and writes one `PURGE_LOG` row per table and run whose count and SHA-256 fingerprint equal what the runner computed beforehand by the auditor's rule in `08_purge.sql`. One run has 1,200 GST rows, so the chunked fingerprint is exercised.

## Running it on a laptop

Docker with about 4 GB of memory free and Python 3.12 with `pip install -r tests/exasol/requirements.txt`.

```
docker run --name exasoldb --detach --privileged --stop-timeout 120 -p 127.0.0.1:8563:8563 exasol/docker-db:2026.1.0
python tests/exasol/run_docker_db.py
docker rm --force exasoldb
```

The runner waits for Exasol to answer (about two minutes after the container starts) and prints one line per phase. A failed check is a plain `assert` with the values that disagreed.
