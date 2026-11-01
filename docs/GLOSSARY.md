# Credora glossary

Every Exasol, banking, AI and AWS term used in Credora, in plain words, with what Exasol does for it in Credora and the code that does it. The same content drives the in-app Explain mode (`frontend/src/explain/glossary.ts`).

All data in Credora is synthetic.

## Contents

- [Exasol](#exasol) (56 terms)
- [Banking](#banking) (44 terms)
- [AI](#ai) (6 terms)
- [AWS](#aws) (4 terms)
- [The Credora app](#the-credora-app) (12 terms)

## Exasol

<a id="adbc-vs-rs"></a>
### adbc-vs-rs

An open-source virtual schema adapter from exasol-labs, written in Rust. One adapter reads both MySQL and PostgreSQL.

**In Exasol.** ADBC_VS.ADBC_ADAPTER (a RUST ADAPTER SCRIPT, v0.7.0) and its scan UDF ADBC_VS.ADBC_SCAN load udf/libadbc_vs_adapter.so from BucketFS. It moves Arrow record batches through ADBC drivers that it downloads into BucketFS on first use (CONNECTION ADBC_VS_BUCKETFS).

**Objects.** `ADBC_VS.ADBC_ADAPTER`, `ADBC_VS.ADBC_SCAN`, `VS_CIF`, `VS_LOS`, `ADBC_VS_BUCKETFS`

From [`exasol/sql/03_virtual_schemas.sql`](../exasol/sql/03_virtual_schemas.sql).

```sql
CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_CIF USING ADBC_VS.ADBC_ADAPTER WITH
  DRIVER          = 'mysql'
  CONNECTION_NAME = 'MYSQL_CIF';
```

**See also.** [Virtual schema](#virtual-schema), [Script Language Container (SLC)](#slc), [BucketFS](#bucketfs)

<a id="bucketfs"></a>
### BucketFS

Exasol's own file store, copied to every node. Code that runs inside the database reads files from it like a local disk.

**In Exasol.** Bucket default of bfsdefault holds the Rust SLC, the adbc-vs-rs library, the ADBC drivers, the Oracle adapter jar, ojdbc17 and every trained model (models/pd_<version>.pkl). The training UDFs upload over HTTPS on port 2581 through CONNECTION BUCKETFS_MODELS. Scoring UDFs read /buckets/bfsdefault/default/models/.

**Objects.** `BUCKETFS_MODELS`, `ADBC_VS_BUCKETFS`

From [`exasol/udf/05_ml_udfs.sql`](../exasol/udf/05_ml_udfs.sql).

```python
conn = exa.get_connection("BUCKETFS_MODELS")
path = f"pd_{version}.pkl"
r = requests.put(f"{conn.address}/{path}", data=buf.getvalue(), auth=(conn.user, conn.password),
                 verify=False, timeout=120)
r.raise_for_status()
ctx.emit(version, "Gradient-boosted trees (scikit-learn HistGradientBoosting, monotonic)", auc, 2 * auc - 1,
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/bucketfs/bucketfs.htm

**See also.** [Pickled model in BucketFS](#pickle-model), [Script Language Container (SLC)](#slc), [MODEL_REGISTRY](#model-registry)

<a id="certified-metric"></a>
### Certified metric

A metric whose definition has been checked and approved, so a number like 'approval rate' means the same thing everywhere.

**In Exasol.** Metrics in CREDORA_SEM.PORTFOLIO are marked PUBLIC CERTIFIED, for example approval_rate = approved_companies / companies_analysed. The model is GOVERNED and published with SEMANTIC_ADMIN.PUBLISH_MODEL. Ask Credora answers from these metrics first.

**Objects.** `CREDORA_SEM.PORTFOLIO`

From [`exasol/semantic/12_credora_model.sql`](../exasol/semantic/12_credora_model.sql).

```sql
METRIC approval_rate AS approved_companies / NULLIF(companies_analysed, 0) ON ENTITY decision RETURNS DOUBLE
  FORMAT ''percentage'' DISPLAY ''Approval rate'' COMMENT ''Pre-approved companies / companies analysed, 0..1''
  SYNONYMS (''approval ratio'', ''hit rate'') RATIO PUBLIC CERTIFIED,
```

**See also.** [Semantic view (exasol-semantic-views)](#semantic-view)

<a id="challenger-model"></a>
### Challenger scorecard model

A second, simpler risk model (logistic regression scorecard) trained next to the main one. It only shadows the main model. It shows what it would decide, but decides nothing.

**In Exasol.** TRAIN_MODEL trains <version>-lr with the Python UDF CREDORA.TRAIN_SCORECARD on the same past loans and hold-out. Step 13 runs CREDORA.SCORE_CHALLENGER, which scores the run with PD_SCORE and writes PD, grade and the decision it would give to CREDORA.CHALLENGER_SCORES.

**Objects.** `CREDORA.TRAIN_SCORECARD`, `CREDORA.SCORE_CHALLENGER`, `CREDORA.CHALLENGER_SCORES`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
local ch = query([[
  SELECT MODEL_VERSION, MODEL_PATH, MODEL_SHA256 FROM CREDORA.MODEL_REGISTRY
  WHERE NOT IS_ACTIVE AND ALGORITHM <> (SELECT MAX(ALGORITHM) FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE)
  ORDER BY TRAINED_AT DESC LIMIT 1]])
```

**See also.** [Risk model (champion)](#risk-model), [Model activation (IS_ACTIVE)](#model-activation), [Lua script library (import)](#lua-import)

<a id="comment-on"></a>
### COMMENT ON

Stores a plain-English description on a table, column, schema or script, inside the database, where every SQL tool and AI can read it.

**In Exasol.** Every Credora table and column (19 tables and 197 columns in CREDORA and CREDORA_STAGE), both schemas, the scheduler's tables and all 15 Credora scripts and UDFs carry their meaning from this glossary. The Exasol MCP server's describe tools return them to Ask Credora, so its prompt lists column names only. Exasol allows comments on views only inside CREATE VIEW.

**Objects.** `EXA_ALL_TABLES.TABLE_COMMENT`, `EXA_ALL_COLUMNS.COLUMN_COMMENT`, `EXA_ALL_SCRIPTS.SCRIPT_COMMENT`

From [`exasol/sql/15_comments.sql`](../exasol/sql/15_comments.sql).

```sql
COMMENT ON TABLE CREDORA.PURGE_LOG IS 'Proof of deletion: what PURGE_EXPIRED deleted, when, and a SHA-256 fingerprint of the deleted content, so an auditor can confirm it without the data.' (
  PURGED_AT IS 'When the rows were deleted',
  ROWS_DELETED IS 'How many rows were deleted',
  SHA256 IS 'SHA-256 of the deleted rows'' key fields, in a fixed order'
);
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/comment.htm

**See also.** [Exasol MCP server](#exasol-mcp-server), [System tables (EXA_ALL_*, EXA_DBA_*)](#system-tables)

<a id="commit-per-step"></a>
### COMMIT per step

Each finished step is saved for good at once, so others can see progress while the job is still running.

**In Exasol.** After each step RUN_ANALYSIS writes a row to CREDORA.RUN_LOG and runs COMMIT. The web app polls RUN_LOG about every 0.8 s from a second session and shows each step as it finishes.

**Objects.** `CREDORA.RUN_LOG`, `CREDORA.RUN_ANALYSIS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
if ok then
  log(no, name, 'OK', res or 0, t0, null)
  query('COMMIT')  -- make each finished step visible to the web app at once
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/transaction_management.htm

**See also.** [Lua script (Exasol scripting)](#lua-script), [RUN_LOG](#run-log), [Sessions](#sessions)

<a id="connection-object"></a>
### CONNECTION object

A named, stored address with a user and password. SQL refers to it by name, so secrets never appear in queries.

**In Exasol.** ORA_CBS, MYSQL_CIF and PG_LOS hold the bank databases. MOCK_CIBIL, MOCK_GSTN and MOCK_AA hold the relay addresses and token of the 3rd party data APIs. BUCKETFS_MODELS and AI_LLM hold the BucketFS and Claude keys. Only R_SVC is granted ACCESS on the API, BucketFS and AI connections.

**Objects.** `ORA_CBS`, `MYSQL_CIF`, `PG_LOS`, `MOCK_CIBIL`, `MOCK_GSTN`, `MOCK_AA`, `BUCKETFS_MODELS`, `AI_LLM`

From [`exasol/sql/02_connections.sql`](../exasol/sql/02_connections.sql).

```sql
CREATE OR REPLACE CONNECTION MOCK_CIBIL
  TO '${MOCK_CIBIL_URL}' USER 'api' IDENTIFIED BY '${MOCK_API_TOKEN}';
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/create_connection.htm

**See also.** [GRANT](#grant), [Python UDF](#python-udf), [Credit memo UDF (CONNECTION AI_LLM)](#credit-memo-udf)

<a id="consumer-group"></a>
### Consumer group

Exasol's workload management. Users are put in groups that get a share of CPU, a priority, a statement time limit and a memory limit.

**In Exasol.** CREDORA_BATCH (high priority) holds CREDORA_SVC, which runs the analysis, training, the CRM export and the Exasol Scheduler's jobs. CREDORA_APP (medium, 5-minute statement limit) holds the role users behind the screens, CREDORA_ADMIN, CREDORA_DATASCI, CREDORA_LOANOPS, CREDORA_RM and the second relationship manager CREDORA_RM002. CREDORA_AI (low, 60 s per statement, 2 GiB of temporary memory per session and 4 GiB for the group) holds the four AI session users CREDORA_ADMIN_AI, CREDORA_DATASCI_AI, CREDORA_LOANOPS_AI and CREDORA_RM_AI, and CREDORA_MCP. A session cannot change its group, so Ask Credora never logs in as the person, and its limits need no session settings. The AI cannot starve or hang the bank's analysis. Every audited statement shows its group.

**Objects.** `EXA_CONSUMER_GROUPS`, `CREDORA_BATCH`, `CREDORA_APP`, `CREDORA_AI`

From [`exasol/sql/16_resources.sql`](../exasol/sql/16_resources.sql).

```sql
ALTER CONSUMER GROUP CREDORA_AI SET PRECEDENCE = '100', CPU_WEIGHT = '100', QUERY_TIMEOUT = 60,
  SESSION_TEMP_DB_RAM_LIMIT = '2G', GROUP_TEMP_DB_RAM_LIMIT = '4G';
ALTER USER CREDORA_SVC SET CONSUMER_GROUP = CREDORA_BATCH;
ALTER USER CREDORA_RM SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_RM_AI SET CONSUMER_GROUP = CREDORA_AI;
ALTER USER CREDORA_MCP SET CONSUMER_GROUP = CREDORA_AI;
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/resource_manager.htm

**See also.** [QUERY_TIMEOUT](#query-timeout), [Exasol audit log](#exasol-audit), [Exasol user](#exasol-user)

<a id="credora-schema"></a>
### CREDORA schema

The schema that holds Credora's results. It stores credit needs on file, features, scores, decisions, models, the run log and policy.

**In Exasol.** The main tables are APPLICATIONS, FEATURES, SCORES, ANOMALY, DECISIONS, CHALLENGER_SCORES, MODEL_REGISTRY, RUN_LOG, CONFIG, PURGE_LOG, MEMOS, RM_ASSIGNMENT, RUN_PUBLISH and LOAN_STATUS_LOG. Every result row carries RUN_ID, so runs are kept side by side.

**Objects.** `CREDORA.DECISIONS`, `CREDORA.FEATURES`, `CREDORA.SCORES`, `CREDORA.RUN_LOG`

**See also.** [CREDORA_STAGE](#credora-stage), [RUN_LOG](#run-log)

<a id="policy-config"></a>
### CREDORA.CONFIG (policy knobs)

The bank's lending policy as numbers, covering base rate, cost of funds, loss rate, capital, hurdle and limits.

**In Exasol.** The decision SQL reads every value from CREDORA.CONFIG, so a policy change is one UPDATE, with no code change. What-if overrides these values inside one query. An approved policy proposal writes them as CREDORA_SVC.

**Objects.** `CREDORA.CONFIG`

From [`exasol/sql/01_schemas.sql`](../exasol/sql/01_schemas.sql).

```sql
CREATE TABLE IF NOT EXISTS CREDORA.CONFIG (
  CONFIG_KEY   VARCHAR(40) PRIMARY KEY,
  CONFIG_VALUE DECIMAL(12,4) NOT NULL,
  DESCRIPTION  VARCHAR(200)
);
```

**See also.** [What-if](#what-if), [Policy proposal](#policy-proposal), [Hurdle rate](#hurdle-rate), [EBLR](#eblr)

<a id="run-analysis"></a>
### CREDORA.RUN_ANALYSIS

The one database call that does the whole daily analysis, from reading the bank's data to ranking the best offers.

**In Exasol.** A Lua script with 13 logged steps. The steps are refresh virtual schemas, read credit needs on file, four API fetches, features, risk model, PD scoring, anomaly flag, decide, PREFERRING rank and challenger shadow scoring. The backend runs EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('<run>') as CREDORA_SVC.

**Objects.** `CREDORA.RUN_ANALYSIS`, `CREDORA.RUN_LOG`, `CREDORA.DECISIONS`

From [`backend/app/jobs.py`](../backend/app/jobs.py).

```python
st = conn.execute("EXECUTE SCRIPT CREDORA.RUN_ANALYSIS({r})", {"r": run_id})
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/execute_script.htm

**See also.** [Lua script (Exasol scripting)](#lua-script), [RUN_LOG](#run-log), [COMMIT per step](#commit-per-step)

<a id="credora-stage"></a>
### CREDORA_STAGE

The schema that holds raw 3rd party data fetched on demand via API (CIBIL, GST, Account Aggregator), each row with a delete-by time.

**In Exasol.** Steps 3 to 6 of RUN_ANALYSIS fill CIBIL_CONSUMER, CIBIL_COMMERCIAL, GST_FILING and AA_ACCOUNT. PURGE_AT is 7 days for CIBIL and GST and the consent expiry for AA. R_LOANOPS, R_RM and R_MCP have no grant on it.

**Objects.** `CREDORA_STAGE.CIBIL_CONSUMER`, `CREDORA_STAGE.CIBIL_COMMERCIAL`, `CREDORA_STAGE.GST_FILING`, `CREDORA_STAGE.AA_ACCOUNT`

From [`exasol/sql/01_schemas.sql`](../exasol/sql/01_schemas.sql).

```sql
CREATE TABLE IF NOT EXISTS CREDORA_STAGE.AA_ACCOUNT (
  RUN_ID VARCHAR(20), PAN CHAR(10), CONSENT_ID VARCHAR(36), CONSENT_EXPIRES TIMESTAMP, AA_ACCOUNT_ID VARCHAR(16),
  FIP VARCHAR(40), ACCT_TYPE VARCHAR(10), MASKED_NO VARCHAR(20), OPENED_ON DATE, CURRENT_BALANCE DECIMAL(18,2),
  TXN_COUNT DECIMAL(8), CREDITS_12M DECIMAL(18,2), DEBITS_12M DECIMAL(18,2), FETCHED_AT TIMESTAMP, PURGE_AT TIMESTAMP
);
```

**See also.** [Purge with SHA-256 proof](#purge-proof), [Schema-level grant](#schema-grant)

<a id="credora-svc"></a>
### CREDORA_SVC

The service login the web app uses for background jobs. People never sign in as it.

**In Exasol.** CREDORA_SVC (role R_SVC) runs RUN_ANALYSIS, TRAIN_MODEL, PURGE_EXPIRED, credit memos and the writes to CONFIG, MODEL_REGISTRY, RM_ASSIGNMENT, RUN_PUBLISH and LOAN_STATUS_LOG. All reads for a signed-in person go through that role's own user instead.

**Objects.** `CREDORA_SVC`, `R_SVC`

From [`backend/app/exa.py`](../backend/app/exa.py).

```python
ROLE_USER = {
    "admin": "CREDORA_ADMIN",
    "datasci": "CREDORA_DATASCI",
    "loanops": "CREDORA_LOANOPS",
    "rm": "CREDORA_RM",
}
SVC = "CREDORA_SVC"
```

**See also.** [Exasol user](#user), [Role](#role), [Sessions](#sessions)

<a id="current-user"></a>
### CURRENT_USER

A SQL function that returns the name of the database user running the query.

**In Exasol.** The V_RM_* views compare RM_ASSIGNMENT.EXA_USER with CURRENT_USER, with the _AI suffix of an AI session user stripped by REGEXP_REPLACE, so the same view returns a different book for each RM login and the AI sees its person's book (in the demo, CREDORA_RM acts for RM001 and CREDORA_RM002 for RM002).

**Objects.** `CREDORA.V_RM_ASSIGNMENT`, `CREDORA.RM_ASSIGNMENT`

From [`exasol/sql/13_rm_row_security.sql`](../exasol/sql/13_rm_row_security.sql).

```sql
CREATE OR REPLACE VIEW CREDORA.V_RM_ASSIGNMENT AS
SELECT a.CIF_ID, a.RM_ID, a.ASSIGNED_BY, a.ASSIGNED_AT
FROM CREDORA.RM_ASSIGNMENT a
WHERE a.EXA_USER = REGEXP_REPLACE(CURRENT_USER, '_AI$', '');
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/current_user.htm

**See also.** [Row-level security view](#row-level-security), [Exasol user](#user)

<a id="exasol-mcp-server"></a>
### Exasol MCP server

Exasol's official server that lets an AI model look up tables and run read-only SQL through standard tool calls (MCP).

**In Exasol.** For each Ask Credora question the backend starts exasol-mcp-server 2.3.0 over stdio, logged in as the person's own AI session user, CREDORA_ADMIN_AI, CREDORA_DATASCI_AI, CREDORA_LOANOPS_AI or CREDORA_RM_AI (exasol_login()). That user holds the same role as the person and sits in consumer group CREDORA_AI, where Exasol itself applies the 60 s statement limit and the 2 GiB temporary memory limit, with no per-session SQL. A signed-in role without a configured AI password gets HTTP 503 with the text "Ask Credora is not set up for this role." CREDORA_MCP remains only for AI clients outside the app. Write queries, BucketFS writes and preprocessor tools are switched off.

**Objects.** `CREDORA_ADMIN_AI`, `CREDORA_RM_AI`, `CREDORA_AI`, `CREDORA_MCP`, `R_MCP`

From [`backend/app/assistant.py`](../backend/app/assistant.py).

```python
MCP_SERVER_PACKAGE = "exasol-mcp-server@2.3.0"
# The read-only user for sessions that belong to no signed-in person (the self-test). A person's
# questions always run as that person's AI session user, see exasol_login.
MCP_USER = "CREDORA_MCP"
AI_USER_SUFFIX = "_AI"
# Read-only: SELECT and metadata only; no writes, no BucketFS, no profiling.
MCP_SETTINGS = {
    "enable_read_query": True,
    "enable_summarize_table": True,
    "enable_query_profiling": False,
    "enable_write_query": False,
    "enable_write_bucketfs": False,
    # The database applies the semantic layer's preprocessor; the assistant must not replace it.
    "enable_preprocessor_tools": False,
```

**See also.** [Ask Credora](#ask-credora), [MCP tool call](#mcp-tool-call), [Ask Credora topic gate](#topic-gate), [Exasol user](#user)

<a id="exasol-personal-aws"></a>
### Exasol Personal on AWS

The free single-node edition of Exasol, installed on an AWS server by Exasol's official launcher.

**In Exasol.** deploy/credora.py runs the exasol launcher (exasol init aws ubuntu) on an r6i.xlarge EC2 instance and limits its ports (8563, 8443, 2581, 22 and others) to the admin's IP. Every Exasol object is then created from the repo by deploy/exasol_setup.py and the exasol/ SQL files.

**Objects.** `CREDORA`, `CREDORA_STAGE`, `VS_CBS`

From [`deploy/credora.py`](../deploy/credora.py).

```python
sh(["exasol", "init", "aws", "ubuntu", "--deployment-dir", str(self.exasol_dir), "--auto-approve",
    "--instance-type", self.cfg.get("EXASOL_INSTANCE", "r6i.xlarge")], env=self.aws_env())
```

**See also.** [EC2 app host](#ec2-app-host), [BucketFS](#bucketfs)

<a id="user"></a>
### Exasol user

A database login. In Credora each app role has its own Exasol user, so the database itself knows who is reading.

**In Exasol.** CREDORA_ADMIN, CREDORA_DATASCI, CREDORA_LOANOPS and CREDORA_RM each hold the matching role, and a second relationship manager CREDORA_RM002 (role R_RM) proves the row filter works for any manager. Each person also has an AI session user, CREDORA_ADMIN_AI, CREDORA_DATASCI_AI, CREDORA_LOANOPS_AI or CREDORA_RM_AI, which holds the same role and sits in consumer group CREDORA_AI, and Ask Credora logs in as it. CREDORA_SVC runs jobs and CREDORA_MCP is the read-only user for AI clients outside the app. Passwords come from the deployment's runtime secret in AWS Secrets Manager.

**Objects.** `CREDORA_ADMIN`, `CREDORA_DATASCI`, `CREDORA_LOANOPS`, `CREDORA_RM`, `CREDORA_RM002`, `CREDORA_RM_AI`, `CREDORA_SVC`, `CREDORA_MCP`

From [`deploy/exasol_setup.py`](../deploy/exasol_setup.py).

```python
def create_users(ex: Exasol, secret: dict) -> None:
    """One Exasol user per app role; passwords come from the deployment's runtime secret."""
    with ex.connect() as c:
        existing = {r[0] for r in c.execute("SELECT USER_NAME FROM EXA_DBA_USERS").fetchall()}
        for user, (role, key) in ROLE_USERS.items():
            verb = "ALTER" if user in existing else "CREATE"
            c.execute(f'{verb} USER {user} IDENTIFIED BY "{secret[key]}"')
            c.execute(f"GRANT {role} TO {user}")
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/create_user.htm

**See also.** [Role](#role), [CREDORA_SVC](#credora-svc), [Sessions](#sessions), [AWS Secrets Manager](#secrets-manager)

<a id="exasol-audit"></a>
### Exasol audit log

Exasol's own record of every statement. It shows who ran it, when, how long it took, how much CPU and memory it used, and whether it worked. It answers the regulator's "who ran what" from the database rather than from the app.

**In Exasol.** Auditing is on. Every Credora session and statement is tagged `credora:<app user>:<feature>`. The tag goes into the session's client name (pyexasol `client_name`) and a leading SQL comment, which Exasol keeps in the audit log. The admin's Exasol audit screen reads EXA_DBA_AUDIT_SQL joined with EXA_DBA_AUDIT_SESSIONS as CREDORA_ADMIN (SELECT ANY DICTIONARY, granted to that user and not to role R_ADMIN, so CREDORA_ADMIN_AI cannot read it), with filters for the Exasol user, app user, feature, result and time, and shows one RUN_ANALYSIS with every statement it ran and the COMMIT that closes each step. Secrets inside `IDENTIFIED BY '...'` are masked with REGEXP_REPLACE inside Exasol before the text leaves the database.

**Objects.** `EXA_DBA_AUDIT_SQL`, `EXA_DBA_AUDIT_SESSIONS`, `CREDORA_ADMIN`

From [`backend/app/exasol_admin.py`](../backend/app/exasol_admin.py).

```sql
SELECT q.START_TIME, s.USER_NAME, s.CLIENT, q.CONSUMER_GROUP, q.SQL_TEXT,
       q.CPU, q.TEMP_DB_RAM_PEAK, q.DURATION, q.SUCCESS
FROM EXA_DBA_AUDIT_SQL q JOIN EXA_DBA_AUDIT_SESSIONS s ON s.SESSION_ID = q.SESSION_ID
WHERE s.USER_NAME LIKE 'CREDORA\_%' AND q.SQL_TEXT LIKE '/*credora:loanops:%'
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/auditing.htm

**See also.** [Consumer group](#consumer-group), [SELECT ANY DICTIONARY](#select-any-dictionary), [Sessions](#sessions)

<a id="exasol-scheduler"></a>
### Exasol Scheduler

An open-source scheduler from exasol-labs whose jobs are rows in an Exasol table. Jobs are defined, run and audited in SQL.

**In Exasol.** One container on the app host (docker-compose.yml, the pinned v0.4.1 release binary) logs in to Exasol as CREDORA_SVC and runs the tasks in SCHED.SCHED_TASKS. `credora_purge_expired` runs every 15 minutes (consent-based data deleted on time, with SHA-256 proof). Nightly at 02:00 IST it runs `credora_refresh_vs_cbs`, with `credora_refresh_vs_cif` and `credora_refresh_vs_los` as finalizers, so they run even if Oracle fails. Every run is a row in SCHED.SCHED_HISTORY. Only the deploy user may write SCHED_TASKS.

**Objects.** `SCHED.SCHED_TASKS`, `SCHED.SCHED_HISTORY`, `CREDORA.PURGE_EXPIRED`

From [`exasol/sql/17_scheduler.sql`](../exasol/sql/17_scheduler.sql).

```sql
SELECT 'credora_purge_expired' TASK_ID, 'CRON 0 */15 * * * * TZ=Asia/Kolkata' SCHED,
       'EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()' SQL_TEXT, ...
```

**Exasol docs.** https://github.com/exasol-labs/exasol-scheduler

**See also.** [Purge with SHA-256 proof](#purge-proof), [Virtual schema refresh](#vs-refresh)

<a id="explain-virtual"></a>
### EXPLAIN VIRTUAL

Asks Exasol which SQL it would send to a source database for a query on a virtual schema, without running the query. The proof that work is pushed down.

**In Exasol.** The Sources screen runs EXPLAIN VIRTUAL live, as the signed-in role's Exasol user, on the analysis's reads. For core banking, Oracle receives the join, the filter and the GROUP BY per account and month. For the credit needs on file, PostgreSQL and MySQL each receive their own projection (and MySQL the partner count per company), and Exasol joins the results.

**Objects.** `VS_CBS`, `VS_CIF`, `VS_LOS`

From [`backend/app/exasol_admin.py`](../backend/app/exasol_admin.py).

```sql
EXPLAIN VIRTUAL
SELECT t.ACCOUNT_NO, a.OWNER_ID CIF_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM') MON, SUM(...), COUNT(*) N
FROM VS_CBS.TXN t JOIN VS_CBS.ACCOUNT a ON a.ACCOUNT_NO = t.ACCOUNT_NO
WHERE a.OWNER_TYPE = 'COMPANY' AND a.ACCT_TYPE = 'CA'
GROUP BY t.ACCOUNT_NO, a.OWNER_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM')
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/explain_virtual.htm

**See also.** [Pushdown](#pushdown), [Virtual schema](#virtual-schema)

<a id="grant"></a>
### GRANT

The SQL statement that gives a permission to a role or user, for example the right to read a table or use a connection.

**In Exasol.** 07_security.sql and 13_rm_row_security.sql grant every right in Credora. A query outside a role's grants fails in Exasol with 'insufficient privileges', and the web app shows 403.

**Objects.** `R_SVC`, `MOCK_CIBIL`, `BUCKETFS_MODELS`

From [`exasol/sql/07_security.sql`](../exasol/sql/07_security.sql).

```sql
GRANT ACCESS ON CONNECTION MOCK_CIBIL TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_GSTN TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_AA TO R_SVC;
GRANT ACCESS ON CONNECTION BUCKETFS_MODELS TO R_SVC;
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/grant.htm

**See also.** [Role](#role), [Schema-level grant](#schema-grant), [CONNECTION object](#connection-object)

<a id="anomaly-flag"></a>
### Isolation Forest anomaly flag

A model that spots companies whose figures look unlike everyone else's, for example GST sales far above bank credits. Flagged companies go to a person. They are never declined for it.

**In Exasol.** Step 10 of RUN_ANALYSIS calls the Python UDF CREDORA.ANOMALY_FLAG as one instance over the run's features and writes CREDORA.ANOMALY. CONFIG ANOMALY_CONTAMINATION_PCT (3%) sets the share flagged. The decision step turns a flag into REFER with the reason `'Anomaly: ...'`.

**Objects.** `CREDORA.ANOMALY_FLAG`, `CREDORA.ANOMALY`, `CREDORA.CONFIG`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
step(10, 'Flag anomalies (Isolation Forest UDF)', function()
  return rows(query([[
    INSERT INTO CREDORA.ANOMALY
    SELECT :r, app_id, score, is_anomaly, top_reasons
    FROM (SELECT CREDORA.ANOMALY_FLAG(f.APP_ID, c.CONFIG_VALUE, f.GST_TURNOVER_12M, f.BANK_CREDITS_12M,
                                      f.AVG_BALANCE_12M, f.INFLOW_VOLATILITY, f.PARTNER_OTHER_BANK_BAL)
          FROM CREDORA.FEATURES f
          LEFT JOIN CREDORA.CONFIG c ON c.CONFIG_KEY = 'ANOMALY_CONTAMINATION_PCT'
          WHERE f.RUN_ID = :r)]], p))
end)
```

**See also.** [Approve / Refer / Decline](#approve-refer-decline), [GST vs bank gap](#gst-bank-gap)

<a id="latest-run-views"></a>
### Latest-run views (V_LATEST_*)

Views that always show the newest finished, published analysis run, one row per company.

**In Exasol.** V_LATEST_RUN picks the newest run in RUN_PUBLISH that finished every step without a failure. V_LATEST_COMPANY, _DECISION, _SCORE and _FEATURE join it, filter rows for RMs, and feed CREDORA_SEM.PORTFOLIO.

**Objects.** `CREDORA.V_LATEST_RUN`, `CREDORA.V_LATEST_DECISION`, `CREDORA.V_LATEST_COMPANY`

From [`exasol/semantic/11_latest_run_views.sql`](../exasol/semantic/11_latest_run_views.sql).

```sql
CREATE OR REPLACE VIEW CREDORA.V_LATEST_RUN AS
SELECT RUN_ID, FINISHED_AT FROM (
  SELECT l.RUN_ID, MAX(l.LOGGED_AT) FINISHED_AT
  FROM CREDORA.RUN_LOG l
  WHERE l.RUN_ID IN (SELECT RUN_ID FROM CREDORA.RUN_PUBLISH)
  GROUP BY l.RUN_ID
  HAVING SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) = 0
     AND (MAX(STEP_NO) >= 13
          OR MAX(CASE WHEN STEP_NO = 11 AND STEP_NAME = 'Rank with PREFERRING skyline' THEN 1 ELSE 0 END) = 1)
) ORDER BY FINISHED_AT DESC, RUN_ID DESC LIMIT 1;
```

**See also.** [Semantic view (exasol-semantic-views)](#semantic-view), [Run publish](#run-publish), [Row-level security view](#row-level-security)

<a id="lua-script"></a>
### Lua script (Exasol scripting)

A program stored in the database that runs SQL statements one after another, with loops, error handling and logging.

**In Exasol.** CREDORA.RUN_ANALYSIS runs the whole daily analysis in one EXECUTE SCRIPT call. TRAIN_MODEL, SCORE_CHALLENGER and PURGE_EXPIRED are Lua scripts too. CREDORA.DECISION_LOGIC is a Lua library that RUN_ANALYSIS and SCORE_CHALLENGER load with import().

**Objects.** `CREDORA.RUN_ANALYSIS`, `CREDORA.TRAIN_MODEL`, `CREDORA.DECISION_LOGIC`, `CREDORA.PURGE_EXPIRED`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
local function step(no, name, fn)
  local t0 = now()
  local ok, res = pcall(fn)
  if ok then
    log(no, name, 'OK', res or 0, t0, null)
    query('COMMIT')  -- make each finished step visible to the web app at once
  else
    log(no, name, 'FAILED', 0, t0, string.sub(tostring(res), 1, 1900))
    error(res)
  end
end
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/scripting.htm

**See also.** [CREDORA.RUN_ANALYSIS](#run-analysis), [COMMIT per step](#commit-per-step), [RUN_LOG](#run-log)

<a id="lua-import"></a>
### Lua script library (import)

One script can load another as a library, so shared logic lives in one place.

**In Exasol.** CREDORA.DECISION_LOGIC holds the decision SQL once. RUN_ANALYSIS runs it on CREDORA.SCORES and SCORE_CHALLENGER runs the same SQL on CREDORA.CHALLENGER_SCORES. Only the scores table name is swapped.

**Objects.** `CREDORA.DECISION_LOGIC`, `CREDORA.RUN_ANALYSIS`, `CREDORA.SCORE_CHALLENGER`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
local i, j = string.find(sql, 'CREDORA.SCORES', 1, true)
return string.sub(sql, 1, i - 1) .. scores .. string.sub(sql, j + 1)
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/scripting/general_script_language.htm

**See also.** [Lua script (Exasol scripting)](#lua-script), [Challenger scorecard model](#challenger-model)

<a id="masked-view"></a>
### Masked company view

A view that shows a company's details with PAN and GSTIN hidden except for their last characters.

**In Exasol.** CREDORA.V_COMPANY_MASKED joins APPLICATIONS and FEATURES and masks PAN and GSTIN in SQL. R_MCP reads it, and V_LATEST_COMPANY (behind the semantic layer) is built on it.

**Objects.** `CREDORA.V_COMPANY_MASKED`, `CREDORA.V_LATEST_COMPANY`

From [`exasol/sql/07_security.sql`](../exasol/sql/07_security.sql).

```sql
CREATE OR REPLACE VIEW CREDORA.V_COMPANY_MASKED AS
SELECT a.RUN_ID, a.APP_ID, a.CIF_ID, a.LEGAL_NAME, a.CONSTITUTION,
       'XXXXXX' || SUBSTR(a.PAN, 7, 4) PAN_MASKED, SUBSTR(a.GSTIN, 1, 2) || 'XXXXXXXXX' || SUBSTR(a.GSTIN, 12, 4) GSTIN_MASKED,
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/create_view.htm

**See also.** [View with owner's rights](#owner-rights-view), [Row-level security view](#row-level-security)

<a id="merge"></a>
### MERGE

One SQL statement that updates matching rows and inserts missing ones.

**In Exasol.** Step 12 MERGEs RANK_NO and TOP50 into CREDORA.DECISIONS. SCORE_CHALLENGER MERGEs the challenger's decision into CREDORA.CHALLENGER_SCORES. The file 01_schemas.sql seeds CREDORA.CONFIG with MERGE so existing policy values are kept.

**Objects.** `CREDORA.DECISIONS`, `CREDORA.CHALLENGER_SCORES`, `CREDORA.CONFIG`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
  MERGE INTO CREDORA.DECISIONS d USING (
    SELECT APP_ID, ROW_NUMBER() OVER (ORDER BY CASE DECISION WHEN 'APPROVE' THEN 1 WHEN 'REFER' THEN 2 ELSE 3 END,
                                               COALESCE(SKYLINE_LAYER, 999), PD, RAROC_OFFER DESC) RN
    FROM CREDORA.DECISIONS WHERE RUN_ID = :r) x
  ON d.APP_ID = x.APP_ID AND d.RUN_ID = :r
  WHEN MATCHED THEN UPDATE SET RANK_NO = x.RN, TOP50 = (x.RN <= 50 AND d.DECISION = 'APPROVE')]], p)
return ranked
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/merge.htm

**See also.** [PREFERRING (skyline)](#preferring-skyline)

<a id="model-activation"></a>
### Model activation (IS_ACTIVE)

Choosing which trained model makes the real decisions. Only one model is active at a time.

**In Exasol.** One UPDATE sets `IS_ACTIVE = (MODEL_VERSION = :v)` in CREDORA.MODEL_REGISTRY, run as CREDORA_SVC after the admin approves. Training keeps the previously active model active in the same transaction. Step 8 of RUN_ANALYSIS reads the active model's MODEL_PATH for scoring.

**Objects.** `CREDORA.MODEL_REGISTRY`

From [`backend/app/activation.py`](../backend/app/activation.py).

```python
def activate(version: str) -> None:
    # The role users are read-only in Exasol; the switch is made by the service account.
    exa.query(exa.SVC, "UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = {v})", {"v": version})
```

**See also.** [MODEL_REGISTRY](#model-registry), [Model activation approval](#model-activation-approval), [Challenger scorecard model](#challenger-model)

<a id="model-registry"></a>
### MODEL_REGISTRY

The table that lists every trained risk model, with when it was trained, how good it is and where the file is.

**In Exasol.** CREDORA.TRAIN_MODEL inserts one row per model with ALGORITHM, AUC, GINI, N_TRAIN, DEFAULT_RATE, FEATURE_IMPORTANCE, MODEL_PATH in BucketFS and MODEL_SHA256, the hash of the pickle the trainer uploaded. PD_SCORE checks the file's SHA-256 against it before unpickling, so a replaced or damaged model file never scores. MODEL_VERSION is the primary key. IS_ACTIVE marks the one model that decides.

**Objects.** `CREDORA.MODEL_REGISTRY`

From [`exasol/sql/01_schemas.sql`](../exasol/sql/01_schemas.sql).

```sql
CREATE TABLE IF NOT EXISTS CREDORA.MODEL_REGISTRY (
  MODEL_VERSION VARCHAR(20), TRAINED_AT TIMESTAMP, ALGORITHM VARCHAR(80), AUC DECIMAL(6,4), GINI DECIMAL(6,4),
  N_TRAIN DECIMAL(10), DEFAULT_RATE DECIMAL(6,4), FEATURE_IMPORTANCE VARCHAR(20000), MODEL_PATH VARCHAR(200),
  IS_ACTIVE BOOLEAN, MODEL_SHA256 VARCHAR(64),
  CONSTRAINT MODEL_REGISTRY_PK PRIMARY KEY (MODEL_VERSION)
);
```

**See also.** [Model activation (IS_ACTIVE)](#model-activation), [Pickled model in BucketFS](#pickle-model), [Challenger scorecard model](#challenger-model)

<a id="omp-num-threads"></a>
### OMP_NUM_THREADS

A setting that tells numeric libraries how many CPU threads to use.

**In Exasol.** PD_SCORE sets it to 1 because Exasol already runs one UDF instance per core (4 instances on the r6i.xlarge). TRAIN_PD, TRAIN_SCORECARD and ANOMALY_FLAG run as one instance and set it to 4.

**Objects.** `CREDORA.PD_SCORE`, `CREDORA.TRAIN_PD`, `CREDORA.ANOMALY_FLAG`

From [`exasol/udf/05_ml_udfs.sql`](../exasol/udf/05_ml_udfs.sql).

```python
os.environ["OMP_NUM_THREADS"] = "1"  # one UDF instance per core already; avoid thread oversubscription
```

**See also.** [Python UDF](#python-udf), [SCALAR vs SET UDF](#scalar-vs-set-udf)

<a id="oracle-vs-adapter"></a>
### Oracle virtual schema adapter

The plug-in that teaches Exasol to talk to Oracle. It turns Exasol queries into Oracle SQL.

**In Exasol.** ADAPTER.ORACLE_ADAPTER is a JAVA ADAPTER SCRIPT (Exasol's oracle-virtual-schema 6.0.0) with the ojdbc17 JDBC driver, both stored in BucketFS. VS_CBS uses it with CONNECTION ORA_CBS, logging in to Oracle as the read-only user CREDORA_RO.

**Objects.** `ADAPTER.ORACLE_ADAPTER`, `VS_CBS`, `ORA_CBS`

From [`deploy/exasol_setup.py`](../deploy/exasol_setup.py).

```python
c.execute("CREATE OR REPLACE JAVA ADAPTER SCRIPT ADAPTER.ORACLE_ADAPTER AS\n"
          "  %scriptclass com.exasol.adapter.RequestDispatcher;\n"
          f"  %jar {b}/vs/{ORACLE_VS_JAR};\n"
          f"  %jar {b}/drivers/jdbc/ojdbc17.jar;\n/\n")
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/virtual_schemas.htm

**See also.** [Virtual schema](#virtual-schema), [Script Language Container (SLC)](#slc), [BucketFS](#bucketfs), [Amazon RDS (Oracle, MySQL, PostgreSQL)](#rds)

<a id="pickle-model"></a>
### Pickled model in BucketFS

A trained model saved as a file (Python pickle), so it can be loaded again later to score new companies.

**In Exasol.** TRAIN_PD and TRAIN_SCORECARD save models/pd_<version>.pkl to BucketFS and emit its SHA-256, stored in MODEL_REGISTRY.MODEL_SHA256. PD_SCORE opens /buckets/bfsdefault/default/models/pd_<version>.pkl, waits up to 60 s for it to reach the node, checks the file's SHA-256 against the registry before unpickling, and caches it per UDF instance.

**Objects.** `CREDORA.PD_SCORE`, `BUCKETFS_MODELS`

From [`exasol/udf/05_ml_udfs.sql`](../exasol/udf/05_ml_udfs.sql).

```python
def load(path, expected_sha256):
    if path not in _cache:
        for _ in range(60):  # a freshly trained model can take a few seconds to sync to every node
            if os.path.exists(path):
                break
            time.sleep(1)
        with open(path, "rb") as f:
            data = f.read()
        # The registry row carries the SHA-256 the trainer computed from the bytes it uploaded. A file
        # that hashes differently was replaced or damaged after training and is never unpickled. Rows
        # registered before the hash existed carry NULL and load unchecked.
        if expected_sha256 is not None:
            found = hashlib.sha256(data).hexdigest()
            if found != expected_sha256.lower():
                raise RuntimeError(f"Model file {path} does not match MODEL_REGISTRY.MODEL_SHA256 "
                                   f"(expected {expected_sha256}, found {found})")
        _cache[path] = pickle.loads(data)
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/bucketfs/bucketfs.htm

**See also.** [BucketFS](#bucketfs), [MODEL_REGISTRY](#model-registry)

<a id="preferring-skyline"></a>
### PREFERRING (skyline)

An Exasol SQL clause that keeps only the rows no other row beats on every chosen measure at once. No weights are needed.

**In Exasol.** Step 12 of RUN_ANALYSIS runs PREFERRING HIGH RAROC_OFFER PLUS LOW PD PLUS HIGH OFFER_AMOUNT over approved companies, layer after layer, and stores the layer in DECISIONS.SKYLINE_LAYER until at least 50 are ranked. The best 50 get TOP50 = TRUE.

**Objects.** `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
UPDATE CREDORA.DECISIONS SET SKYLINE_LAYER = :l
WHERE RUN_ID = :r AND APP_ID IN (
  SELECT APP_ID FROM CREDORA.DECISIONS
  WHERE RUN_ID = :r AND DECISION = 'APPROVE' AND SKYLINE_LAYER IS NULL
  PREFERRING HIGH RAROC_OFFER PLUS LOW PD PLUS HIGH OFFER_AMOUNT)]], {r = run_id, l = layer})
```

**Exasol docs.** https://docs.exasol.com/db/latest/advanced_analytics/skyline.htm

**See also.** [Top 50](#top-50), [RAROC](#raroc), [PD (probability of default)](#pd)

<a id="preprocessor-library"></a>
### Preprocessor library (exasol-labs/preprocessor-library)

Ready-made SQL rewrites from exasol-labs, installed into Exasol with one statement through the preprocessor framework.

**In Exasol.** `cast_shorthand` (`x::DECIMAL(6,4)` becomes `CAST(x AS DECIMAL(6,4))`) and `trailing_comma` (`SELECT a, b, FROM t` still works), pinned to release v0.3.1 and checked against the release's SHA-256, run for the roles whose sessions send AI-written SQL (R_ADMIN, R_DATASCI, R_LOANOPS, R_RM, R_MCP). Both are TRANSLATE modules, so they run before the semantic layer's EXPAND. Claude's PostgreSQL habits reach Exasol as valid SQL, and semantic SQL still works. CREDORA_SVC's SQL is never rewritten. A known limit of v0.3.1 is that a quoted literal before `::` (`'12.5'::DECIMAL`) is left unchanged.

**Objects.** `PREPROC_RT.CAST_SHORTHAND_V1`, `PREPROC_RT.ERGONOMICS_TRAILING_COMMA_V2`, `PREPROC_RT.INSTALLED_MODULES`

From [`deploy/exasol_setup.py`](../deploy/exasol_setup.py) (`install_preprocessor_library`, the procedure behind `PREPROC INSTALL MODULE`).

```sql
EXECUTE SCRIPT PREPROC.MODULE_INSTALL(
  'https://raw.githubusercontent.com/exasol-labs/preprocessor-library/v0.3.1/registry/index.json',
  'cast_shorthand', 'ROLE:R_ADMIN');
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_DATASCI', 'TRANSLATE', 'PREPROC_RT.CAST_SHORTHAND_V1', 'cast_shorthand', NULL, TRUE);
```

**Exasol docs.** https://github.com/exasol-labs/preprocessor-library

**See also.** [SQL preprocessor (preprocessor-framework)](#sql-preprocessor), [Semantic view](#semantic-view)

<a id="purge-proof"></a>
### Purge with SHA-256 proof

3rd party data fetched via API is deleted on time, and a fingerprint of what was deleted is kept, so an auditor can check it without the data.

**In Exasol.** CREDORA.PURGE_EXPIRED finds CREDORA_STAGE rows past PURGE_AT, sorts them by key, cuts them into chunks of 1,000, hashes each chunk with HASH_SHA256 of LISTAGG and writes the row count and the hash of the chunk hashes to CREDORA.PURGE_LOG, then deletes them. One run's GST rows are above Exasol's 2,000,000-character LISTAGG limit, so one hash over all rows is not possible. Each table is purged in its own transaction, and the whole purge is skipped while an analysis logged a step in the last 3 minutes. The Exasol Scheduler, a container on the app host, runs it as CREDORA_SVC every 15 minutes (task `credora_purge_expired` in SCHED.SCHED_TASKS) and records each run in SCHED.SCHED_HISTORY.

**Objects.** `CREDORA.PURGE_EXPIRED`, `CREDORA.PURGE_LOG`, `CREDORA_STAGE`, `SCHED.SCHED_TASKS`

From [`exasol/lua/08_purge.sql`](../exasol/lua/08_purge.sql).

```lua
local runs = query([[
  SELECT RUN_ID, CAST(SUM(N) AS DECIMAL(18)) N, HASH_SHA256(LISTAGG(H, '|') WITHIN GROUP (ORDER BY CHUNK_NO)) H
  FROM (SELECT RUN_ID, CHUNK_NO, COUNT(*) N, HASH_SHA256(LISTAGG(K, '|') WITHIN GROUP (ORDER BY K)) H
        FROM (SELECT RUN_ID, ]] .. x.key .. [[ K,
                     FLOOR((ROW_NUMBER() OVER (PARTITION BY RUN_ID ORDER BY ]] .. x.key .. [[) - 1) / 1000) CHUNK_NO
              FROM CREDORA_STAGE.]] .. x.t .. [[ WHERE ]] .. due .. [[)
        GROUP BY RUN_ID, CHUNK_NO)
  GROUP BY RUN_ID]], {c = cutoff})
for i = 1, #runs do
  query([[INSERT INTO CREDORA.PURGE_LOG VALUES (SYSTIMESTAMP, :t, :r, :n, :h)]],
        {t = 'CREDORA_STAGE.' .. x.t, r = runs[i].RUN_ID, n = runs[i].N, h = runs[i].H})
  local res = query('DELETE FROM CREDORA_STAGE.' .. x.t .. ' WHERE RUN_ID = :r AND ' .. due,
                    {r = runs[i].RUN_ID, c = cutoff})
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/hash_sha256.htm

**See also.** [CREDORA_STAGE](#credora-stage), [Consent (AA)](#consent)

<a id="pushdown"></a>
### Pushdown

Exasol hands filters, joins and sums to the source database, so only the result travels back, not every raw row.

**In Exasol.** Step 7 of CREDORA.RUN_ANALYSIS (Compute features) groups about 850,000 Oracle transactions per account and month through VS_CBS. Oracle does the join, the filter and the GROUP BY. About 19,000 monthly totals come back to CREDORA_STAGE.CA_MONTHLY. The month is grouped as `TO_CHAR(TXN_DATE, 'YYYY-MM')` because the Oracle adapter pushes `TO_CHAR` but not `TRUNC(date, 'MM')`. With `TRUNC`, Oracle sent every transaction and Exasol grouped them (EXPLAIN VIRTUAL showed it), and the step took about 10.5 s instead of about 3 s.

**Objects.** `VS_CBS.TXN`, `VS_CBS.ACCOUNT`, `CREDORA_STAGE.CA_MONTHLY`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
query([[INSERT INTO CREDORA_STAGE.CA_MONTHLY
        SELECT m.ACCOUNT_NO, m.CIF_ID, TO_TIMESTAMP(m.MON || '-01', 'YYYY-MM-DD'), m.CREDITS, m.DEBITS,
               m.BOUNCES, m.BAL_SUM, m.N
        FROM (SELECT t.ACCOUNT_NO, a.OWNER_ID CIF_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM') MON,
                     SUM(CASE WHEN t.DR_CR = 'C' THEN t.AMOUNT ELSE 0 END) CREDITS,
                     SUM(CASE WHEN t.DR_CR = 'D' THEN 1 ELSE 0 END) DEBITS,
                     SUM(CASE WHEN t.BOUNCED = 'Y' THEN 1 ELSE 0 END) BOUNCES,
                     SUM(t.BALANCE_AFTER) BAL_SUM, COUNT(*) N
              FROM VS_CBS.TXN t JOIN VS_CBS.ACCOUNT a ON a.ACCOUNT_NO = t.ACCOUNT_NO
              WHERE a.OWNER_TYPE = 'COMPANY' AND a.ACCT_TYPE = 'CA'
              GROUP BY t.ACCOUNT_NO, a.OWNER_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM')) m]])
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/virtual_schemas.htm

**See also.** [Virtual schema](#virtual-schema), [CREDORA.RUN_ANALYSIS](#run-analysis), [EXPLAIN VIRTUAL](#explain-virtual)

<a id="python-udf"></a>
### Python UDF

A UDF written in Python 3. It can use libraries such as requests and scikit-learn.

**In Exasol.** Credora's Python UDFs run in the PYTHON3 language. They read credentials with exa.get_connection() and loop over their input rows with ctx.next() or ctx.get_dataframe().

**Objects.** `CREDORA.CIBIL_CONSUMER_FETCH`, `CREDORA.TRAIN_PD`, `CREDORA.ANOMALY_FLAG`

From [`exasol/udf/04_api_udfs.sql`](../exasol/udf/04_api_udfs.sql).

```python
def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    pans = keys(ctx, "pan")
    for i in range(0, len(pans), 500):
        r = requests.post(f"{conn.address}/v1/consumer/bulk", json={"pans": pans[i:i + 500]},
                          headers={"X-API-Key": conn.password}, timeout=120)
        r.raise_for_status()
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/udf_scripts/python3.htm

**See also.** [UDF (user defined function)](#udf), [CONNECTION object](#connection-object), [SCALAR vs SET UDF](#scalar-vs-set-udf)

<a id="query-timeout"></a>
### QUERY_TIMEOUT

The longest a single statement may run before Exasol cancels it.

**In Exasol.** Ask Credora's sessions log in as the person's AI session user, which sits in consumer group CREDORA_AI, so Exasol itself cancels any statement after 60 s and caps temporary memory at 2 GiB per session. No ALTER SESSION is run, and there is no per-session SQL to get right. CREDORA_APP carries a 300 s limit for the screens, and CREDORA_BATCH has none. The wrapper mcp_session.py only sets the client name `credora:<app user>:ask-credora` for the audit log. A runaway AI query ends with "Query terminated because timeout has been reached".

**Objects.** `EXA_CONSUMER_GROUPS`, `CREDORA_AI`, `CREDORA_APP`

From [`exasol/sql/16_resources.sql`](../exasol/sql/16_resources.sql).

```sql
ALTER CONSUMER GROUP CREDORA_BATCH SET PRECEDENCE = '900', CPU_WEIGHT = '900', QUERY_TIMEOUT = 0;
ALTER CONSUMER GROUP CREDORA_APP SET PRECEDENCE = '500', CPU_WEIGHT = '400', QUERY_TIMEOUT = 300;
ALTER CONSUMER GROUP CREDORA_AI SET PRECEDENCE = '100', CPU_WEIGHT = '100', QUERY_TIMEOUT = 60,
  SESSION_TEMP_DB_RAM_LIMIT = '2G', GROUP_TEMP_DB_RAM_LIMIT = '4G';
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/alter_consumer_group.htm

**See also.** [Consumer group](#consumer-group), [Exasol MCP server](#exasol-mcp-server)

<a id="rm-assignment"></a>
### RM assignment

Loan operations decides which relationship manager works which company.

**In Exasol.** CREDORA.RM_ASSIGNMENT has one row per company with RM_ID and EXA_USER, the Exasol user that logs in for that manager. Assigning again moves the company. The web app MERGEs it as CREDORA_SVC. The V_RM_* views filter on it with CURRENT_USER, minus the _AI suffix of an AI session user. The demo has two manager users, CREDORA_RM for RM001 and CREDORA_RM002 for RM002.

**Objects.** `CREDORA.RM_ASSIGNMENT`, `CREDORA.V_RM_ASSIGNMENT`

From [`exasol/sql/13_rm_row_security.sql`](../exasol/sql/13_rm_row_security.sql).

```sql
CREATE TABLE IF NOT EXISTS CREDORA.RM_ASSIGNMENT (
  CIF_ID      VARCHAR(8) NOT NULL,
  RM_ID       VARCHAR(6) NOT NULL,     -- relationship manager in the customer master (cif.rm)
  EXA_USER    VARCHAR(128) NOT NULL,   -- the Exasol user that logs in for this manager
  ASSIGNED_BY VARCHAR(20) NOT NULL,    -- web app user of loan operations
  ASSIGNED_AT TIMESTAMP NOT NULL
);
```

**See also.** [Row-level security view](#row-level-security), [CURRENT_USER](#current-user), [RM (relationship manager)](#rm)

<a id="role"></a>
### Role

A named bundle of permissions. Give a role to a user, and the user gets all its permissions.

**In Exasol.** There are six roles, R_SVC (runs analysis, training and purge), R_ADMIN, R_DATASCI, R_LOANOPS, R_RM and R_MCP. The deploy tool creates them (deploy/exasol_setup.py create_roles). The file 07_security.sql grants them their rights.

**Objects.** `R_SVC`, `R_ADMIN`, `R_DATASCI`, `R_LOANOPS`, `R_RM`, `R_MCP`

From [`deploy/exasol_setup.py`](../deploy/exasol_setup.py).

```python
def create_roles(ex: Exasol) -> None:
    with ex.connect() as c:
        existing = {r[0] for r in c.execute("SELECT ROLE_NAME FROM EXA_DBA_ROLES").fetchall()}
        for role in {r for r, _ in ROLE_USERS.values()} - existing:
            c.execute(f"CREATE ROLE {role}")
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/create_role.htm

**See also.** [Exasol user](#user), [GRANT](#grant), [Schema-level grant](#schema-grant)

<a id="row-level-security"></a>
### Row-level security view

A view that returns only the rows the logged-in person may see, decided by the database rather than the app.

**In Exasol.** Each V_RM_* view joins CREDORA.RM_ASSIGNMENT on EXA_USER = REGEXP_REPLACE(CURRENT_USER, '_AI$', '') and CREDORA.RUN_PUBLISH, so a relationship manager gets only assigned companies from published runs, and the AI session user CREDORA_RM_AI sees exactly the book of CREDORA_RM. The V_LATEST_* views behind the semantic layer apply the same filter through V_SESSION_SCOPE. The control room panel "Row-level security, proven by Exasol" (GET /api/admin/rls-proof) runs the same SELECT as CREDORA_RM, CREDORA_RM_AI and CREDORA_RM002 and shows Exasol refusing CREDORA_RM on CREDORA.DECISIONS.

**Objects.** `CREDORA.V_RM_DECISIONS`, `CREDORA.V_RM_COMPANY`, `CREDORA.V_RM_FEATURES`, `CREDORA.V_RM_SCORES`, `CREDORA.V_RM_ASSIGNMENT`, `CREDORA.V_RM_LOAN_STATUS`

From [`exasol/sql/13_rm_row_security.sql`](../exasol/sql/13_rm_row_security.sql).

```sql
CREATE OR REPLACE VIEW CREDORA.V_RM_DECISIONS AS
SELECT d.*
FROM CREDORA.DECISIONS d
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID AND a.EXA_USER = REGEXP_REPLACE(CURRENT_USER, '_AI$', '')
JOIN CREDORA.RUN_PUBLISH p ON p.RUN_ID = d.RUN_ID;
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/create_view.htm

**See also.** [RM assignment](#rm-assignment), [CURRENT_USER](#current-user), [View with owner's rights](#owner-rights-view), [Run publish](#run-publish)

<a id="run-publish"></a>
### Run publish

A finished analysis run is a draft until the data scientist publishes it. Loan operations and RMs then work from it.

**In Exasol.** Publishing inserts a row into CREDORA.RUN_PUBLISH as CREDORA_SVC. V_LATEST_RUN and every V_RM_* view read only published runs, so the semantic layer and the RM book switch to the new run at once.

**Objects.** `CREDORA.RUN_PUBLISH`, `CREDORA.V_LATEST_RUN`

From [`exasol/sql/13_rm_row_security.sql`](../exasol/sql/13_rm_row_security.sql).

```sql
CREATE TABLE IF NOT EXISTS CREDORA.RUN_PUBLISH (
  RUN_ID       VARCHAR(20) NOT NULL,
  PUBLISHED_BY VARCHAR(40) NOT NULL,
  PUBLISHED_AT TIMESTAMP NOT NULL,
  NOTE         VARCHAR(400)
);
```

**See also.** [Latest-run views (V_LATEST_*)](#latest-run-views), [Row-level security view](#row-level-security)

<a id="run-log"></a>
### RUN_LOG

The diary of an analysis run, with one line per step showing rows produced and time taken.

**In Exasol.** RUN_ANALYSIS writes CREDORA.RUN_LOG (RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, DETAIL) after every step. The run screens and the Exasol report read it.

**Objects.** `CREDORA.RUN_LOG`

From [`exasol/sql/01_schemas.sql`](../exasol/sql/01_schemas.sql).

```sql
CREATE TABLE IF NOT EXISTS CREDORA.RUN_LOG (
  RUN_ID       VARCHAR(20),
  STEP_NO      DECIMAL(3),
  STEP_NAME    VARCHAR(100),
  STATUS       VARCHAR(10),
  ROWS_OUT     DECIMAL(18),
  MS           DECIMAL(18),
  DETAIL       VARCHAR(2000),
  LOGGED_AT    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

**See also.** [CREDORA.RUN_ANALYSIS](#run-analysis), [COMMIT per step](#commit-per-step)

<a id="scalar-vs-set-udf"></a>
### SCALAR vs SET UDF

A SCALAR UDF handles one row at a time. A SET UDF gets a whole group of rows at once, which suits bulk API calls and model training.

**In Exasol.** The fetch, training and scoring UDFs are SET scripts. GROUP BY SUBSTR(HASH_MD5(key), 1, 1) spreads the keys over 16 batches (one hex digit of an MD5), and Exasol runs the UDF instances 4 at a time on the 4-core node. Each API call is tried up to 3 times, with pauses of 1 s and 2 s, before the run fails with the service named. PD_SCORE uses 4 groups, one per core. CREDORA.CREDIT_MEMO is a SCALAR script that EMITS one memo per company row.

**Objects.** `CREDORA.CIBIL_CONSUMER_FETCH`, `CREDORA.PD_SCORE`, `CREDORA.CREDIT_MEMO`

From [`exasol/udf/09_ai_udf.sql`](../exasol/udf/09_ai_udf.sql).

```sql
CREATE OR REPLACE PYTHON3 SCALAR SCRIPT CREDORA.CREDIT_MEMO(
  conn_name VARCHAR(100), model VARCHAR(80), cif_id VARCHAR(8), facts VARCHAR(20000))
EMITS (cif_id VARCHAR(8), memo VARCHAR(20000)) AS
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/udf_scripts/udf_overview.htm

**See also.** [UDF (user defined function)](#udf), [Python UDF](#python-udf)

<a id="schema-grant"></a>
### Schema-level grant

One grant that covers every table and view in a schema, now and later.

**In Exasol.** R_ADMIN and R_DATASCI read all of CREDORA and CREDORA_STAGE. R_LOANOPS reads CREDORA but not CREDORA_STAGE, so loan operations never sees raw CIBIL, GST or AA replies. R_SVC gets SELECT, INSERT, UPDATE, DELETE on both schemas.

**Objects.** `CREDORA`, `CREDORA_STAGE`, `VS_CBS`, `VS_CIF`, `VS_LOS`

From [`exasol/sql/07_security.sql`](../exasol/sql/07_security.sql).

```sql
GRANT SELECT ON SCHEMA CREDORA TO R_ADMIN, R_DATASCI;
GRANT SELECT ON SCHEMA CREDORA_STAGE TO R_ADMIN, R_DATASCI;
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/grant.htm

**See also.** [GRANT](#grant), [CREDORA_STAGE](#credora-stage)

<a id="slc"></a>
### Script Language Container (SLC)

A packaged runtime that lets Exasol run code in a language such as Python, Java or Rust right next to the data.

**In Exasol.** The API, ML and AI UDFs run in the built-in PYTHON3 language. The Oracle adapter runs in Java. For adbc-vs-rs the deploy tool uploads the Rust SLC 0.23.1 to BucketFS (slc/rustslc.tar.gz) and registers it as RUST with ALTER SYSTEM SET SCRIPT_LANGUAGES.

**Objects.** `PYTHON3`, `JAVA`, `RUST`

From [`deploy/exasol_setup.py`](../deploy/exasol_setup.py).

```python
def install_rust_slc(ex: Exasol) -> None:
    """Rust language container pinned to the SDK version adbc-vs-rs was built with."""
    if "slc/rustslc.tar.gz" not in ex.bfs_list():
        print("  uploading Rust SLC")
        ex.bfs_put("slc/rustslc.tar.gz", fetch("lc-rust.tar.gz"))
    ex.bfs_extracted("slc/rustslc/exaudf/exaudfclient")
    alias = (f"RUST=localzmq+protobuf:///bfsdefault/{ex.bucket}/slc/rustslc?lang=rust"
             f"#buckets/bfsdefault/{ex.bucket}/slc/rustslc/exaudf/exaudfclient")
    register_language(ex, "RUST", alias)
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/udf_scripts/adding_new_packages_script_languages.htm

**See also.** [UDF (user defined function)](#udf), [BucketFS](#bucketfs), [adbc-vs-rs](#adbc-vs-rs)

<a id="select-any-dictionary"></a>
### SELECT ANY DICTIONARY

A system privilege to read every system table, including those about other users and sessions.

**In Exasol.** Only the user CREDORA_ADMIN holds it in Credora, not the role R_ADMIN, so the admin's AI session user CREDORA_ADMIN_AI (same role) cannot read the audit log or the system tables of anyone. 07_security.sql revokes it from R_ADMIN on older deployments. Other users see the EXA_ALL_* tables, which list only objects they may use.

**Objects.** `CREDORA_ADMIN`, `R_ADMIN`

From [`exasol/sql/16_resources.sql`](../exasol/sql/16_resources.sql).

```sql
GRANT SELECT ANY DICTIONARY TO CREDORA_ADMIN;
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/privileges.htm

**See also.** [System tables (EXA_ALL_*, EXA_DBA_*)](#system-tables), [Role](#role)

<a id="semantic-view"></a>
### Semantic view (exasol-semantic-views)

A business-friendly layer over tables. It has named metrics and dimensions that people and AI query the same way.

**In Exasol.** CREDORA_SEM.PORTFOLIO is built with exasol-labs/exasol-semantic-views v0.5.1 over the V_LATEST_* views, with one row per company of the latest published run. Its dimensions include industry, grade, decision and rm_id. Its metrics include approved_companies, approval_rate and pre_approved_amount.

**Objects.** `CREDORA_SEM.PORTFOLIO`, `CREDORA.V_LATEST_DECISION`, `CREDORA.V_LATEST_COMPANY`

From [`exasol/semantic/12_credora_model.sql`](../exasol/semantic/12_credora_model.sql).

```sql
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SEMANTIC_OBJECT('credora', 'PORTFOLIO', 'company',
  'Pre-approved offer portfolio of the latest completed analysis run: one row per company');
```

**See also.** [Certified metric](#certified-metric), [SQL preprocessor (preprocessor-framework)](#sql-preprocessor), [Latest-run views (V_LATEST_*)](#latest-run-views), [Ask Credora](#ask-credora)

<a id="sessions"></a>
### Sessions

A session is one open connection to Exasol, with its own settings and transaction.

**In Exasol.** The backend keeps a small pool of pyexasol sessions per Exasol user (client name credora-backend). Long jobs such as RUN_ANALYSIS get their own CREDORA_SVC session. Each Ask Credora question starts an MCP server that opens its own session as the person's AI session user (CREDORA_<ROLE>_AI, consumer group CREDORA_AI).

**Objects.** `CREDORA_SVC`, `CREDORA_RM`, `EXA_ALL_SESSIONS`

From [`backend/app/exa.py`](../backend/app/exa.py).

```python
def _connect(user: str) -> pyexasol.ExaConnection:
    try:
        return pyexasol.connect(
            dsn=f"{settings.exasol_host}:{settings.exasol_port}",
            user=user,
            password=settings.exa_passwords.get(user, ""),
            encryption=True,
            websocket_sslopt={"cert_reqs": ssl.CERT_NONE},  # Exasol's certificate is self-signed
            compression=True,
            fetch_mapper=pyexasol.exasol_mapper,
            connection_timeout=10,
            socket_timeout=300,
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql_references/system_tables/metadata/exa_all_sessions.htm

**See also.** [Exasol user](#user), [COMMIT per step](#commit-per-step), [Exasol MCP server](#exasol-mcp-server)

<a id="sql-preprocessor"></a>
### SQL preprocessor (preprocessor-framework)

A script that can rewrite each SQL statement before Exasol runs it. Exasol has one system-wide slot for it.

**In Exasol.** PREPROC_RT.MASTER from exasol-labs/preprocessor-framework v0.9.1 owns the slot (ALTER SYSTEM SET SQL_PREPROCESSOR_SCRIPT) and runs per user the modules its rules name. The module PREPROC_RT.SEMANTIC_VIEWS_V1 turns semantic SQL into plain SQL for R_ADMIN, R_DATASCI, R_LOANOPS, R_RM and R_MCP. CREDORA_SVC has no rule.

**Objects.** `PREPROC_RT.MASTER`, `PREPROC_RT.SEMANTIC_VIEWS_V1`, `PREPROC.CONFIG`

From [`exasol/extensions/10_semantic_views_module.sql`](../exasol/extensions/10_semantic_views_module.sql).

```sql
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_MCP', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_ADMIN', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_DATASCI', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_LOANOPS', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_RM', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/sql_preprocessor.htm

**See also.** [Semantic view (exasol-semantic-views)](#semantic-view), [Role](#role)

<a id="system-tables"></a>
### System tables (EXA_ALL_*, EXA_DBA_*)

Read-only tables in which Exasol describes its users, roles, connections, columns, parameters and sessions.

**In Exasol.** The backend checks EXA_ALL_CONNECTIONS for AI_LLM and EXA_ALL_COLUMNS for view columns. The deploy tool reads EXA_DBA_ROLES, EXA_DBA_USERS and EXA_PARAMETERS. V_SESSION_SCOPE reads EXA_DBA_ROLE_PRIVS.

**Objects.** `EXA_ALL_CONNECTIONS`, `EXA_ALL_COLUMNS`, `EXA_DBA_ROLE_PRIVS`, `EXA_PARAMETERS`

From [`backend/app/memo.py`](../backend/app/memo.py).

```python
val = bool(exa.scalar(exa.SVC, "SELECT COUNT(*) FROM EXA_ALL_CONNECTIONS WHERE CONNECTION_NAME = 'AI_LLM'"))
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql_references/system_tables.htm

**See also.** [SELECT ANY DICTIONARY](#select-any-dictionary)

<a id="udf"></a>
### UDF (user defined function)

Your own function, written in a language like Python, that you call from SQL. Exasol runs it in parallel inside the database.

**In Exasol.** Credora's UDFs fetch CIBIL, GST and Account Aggregator data (CIBIL_CONSUMER_FETCH, CIBIL_COMMERCIAL_FETCH, GST_FETCH, AA_FETCH), train and score models (TRAIN_PD, TRAIN_SCORECARD, PD_SCORE, ANOMALY_FLAG) and write credit memos (CREDIT_MEMO), all in schema CREDORA.

**Objects.** `CREDORA.GST_FETCH`, `CREDORA.PD_SCORE`, `CREDORA.TRAIN_PD`, `CREDORA.CREDIT_MEMO`

From [`exasol/udf/04_api_udfs.sql`](../exasol/udf/04_api_udfs.sql).

```sql
CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.GST_FETCH(conn_name VARCHAR(100), gstin VARCHAR(15))
EMITS (gstin VARCHAR(15), legal_name VARCHAR(120), pan VARCHAR(10), state_name VARCHAR(30), registered_on DATE,
       reg_status VARCHAR(10), stage VARCHAR(12), gst_period VARCHAR(7), gstr1_turnover DOUBLE,
       gstr3b_tax_paid DOUBLE, due_date DATE, filed_on DATE, delay_days DOUBLE) AS
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/udf_scripts.htm

**See also.** [SCALAR vs SET UDF](#scalar-vs-set-udf), [Python UDF](#python-udf), [Script Language Container (SLC)](#slc)

<a id="owner-rights-view"></a>
### View with owner's rights

An Exasol view reads its tables with the rights of the view's owner. A user only needs the right to read the view, not the tables under it.

**In Exasol.** R_RM is granted the V_RM_* views but has no grant on DECISIONS, SCORES, FEATURES or APPLICATIONS. CREDORA.V_SESSION_SCOPE reads EXA_DBA_ROLE_PRIVS with its owner's rights to tell whether the logged-in user holds R_RM, and strips the _AI suffix of an AI session user from CURRENT_USER.

**Objects.** `CREDORA.V_SESSION_SCOPE`, `CREDORA.V_RM_DECISIONS`, `CREDORA.V_LATEST_DECISION`

From [`exasol/sql/13_rm_row_security.sql`](../exasol/sql/13_rm_row_security.sql).

```sql
CREATE OR REPLACE VIEW CREDORA.V_SESSION_SCOPE AS
SELECT REGEXP_REPLACE(CURRENT_USER, '_AI$', '') EXA_USER,
       CASE WHEN EXISTS (SELECT 1 FROM EXA_DBA_ROLE_PRIVS p
                         WHERE p.GRANTEE = CURRENT_USER AND p.GRANTED_ROLE = 'R_RM') THEN TRUE ELSE FALSE END IS_RM
FROM DUAL;
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/create_view.htm

**See also.** [Row-level security view](#row-level-security), [CURRENT_USER](#current-user)

<a id="virtual-schema"></a>
### Virtual schema

A schema in Exasol whose tables really live in another database. You query it like any Exasol schema, and the data stays where it is.

**In Exasol.** VS_CBS reads Oracle core banking, VS_CIF reads the MySQL customer master and VS_LOS reads PostgreSQL loan origination. No bank data is copied into Exasol. Each query is sent to the source database.

**Objects.** `VS_CBS`, `VS_CIF`, `VS_LOS`, `ORA_CBS`, `MYSQL_CIF`, `PG_LOS`

From [`exasol/sql/03_virtual_schemas.sql`](../exasol/sql/03_virtual_schemas.sql).

```sql
CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_CBS USING ADAPTER.ORACLE_ADAPTER WITH
  CONNECTION_NAME = 'ORA_CBS'
  SCHEMA_NAME     = 'CBS';
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/virtual_schemas.htm

**See also.** [Pushdown](#pushdown), [Virtual schema refresh](#vs-refresh), [Oracle virtual schema adapter](#oracle-vs-adapter), [adbc-vs-rs](#adbc-vs-rs), [CONNECTION object](#connection-object)

<a id="vs-refresh"></a>
### Virtual schema refresh

A virtual schema remembers the list of tables and columns in the source. A refresh reads that list again, so new or rebuilt tables are seen.

**In Exasol.** Step 1 of CREDORA.RUN_ANALYSIS runs ALTER VIRTUAL SCHEMA ... REFRESH on VS_CBS, VS_CIF and VS_LOS as CREDORA_SVC. R_SVC holds the system privilege ALTER ANY VIRTUAL SCHEMA REFRESH for this.

**Objects.** `VS_CBS`, `VS_CIF`, `VS_LOS`, `R_SVC`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
step(1, 'Refresh virtual schemas', function()
  for _, vs in ipairs({'VS_CBS', 'VS_CIF', 'VS_LOS'}) do
    query('ALTER VIRTUAL SCHEMA ' .. vs .. ' REFRESH')
  end
  return 3
end)
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql/alter_schema.htm

**See also.** [Virtual schema](#virtual-schema), [CREDORA.RUN_ANALYSIS](#run-analysis)

<a id="window-functions"></a>
### Window functions

SQL functions that look at neighbouring rows, such as numbering rows in order, without collapsing them into one.

**In Exasol.** Step 7 numbers each company's GST returns newest first with ROW_NUMBER() OVER (PARTITION BY ...) to keep the last 12. Step 12 numbers all decisions with ROW_NUMBER() OVER (ORDER BY ...) to set RANK_NO.

**Objects.** `CREDORA.FEATURES`, `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
gst_ranked AS (
  SELECT app.APP_ID, g.*, ROW_NUMBER() OVER (PARTITION BY app.APP_ID ORDER BY g.GST_PERIOD DESC) RN
  FROM app JOIN CREDORA_STAGE.GST_FILING g ON g.GSTIN = app.GSTIN AND g.RUN_ID = :r
  WHERE g.GST_PERIOD < app.AS_OF_PERIOD),
```

**Exasol docs.** https://docs.exasol.com/db/latest/sql_references/functions/analyticfunctions.htm

**See also.** [CREDORA.RUN_ANALYSIS](#run-analysis)

## Banking

<a id="account-aggregator"></a>
### Account Aggregator (AA)

India's consent-based way to share bank account data between institutions. With the customer's permission, another bank's account data flows to the lender.

**In Exasol.** Step 6 calls CREDORA.AA_FETCH through CONNECTION MOCK_AA (aa.credora.link) for every partner into CREDORA_STAGE.AA_ACCOUNT. FEATURES.PARTNER_OTHER_BANK_BAL sums the balances.

**Objects.** `CREDORA.AA_FETCH`, `MOCK_AA`, `CREDORA_STAGE.AA_ACCOUNT`

From [`exasol/udf/04_api_udfs.sql`](../exasol/udf/04_api_udfs.sql).

```python
r = requests.post(f"{conn.address}/v1/fi/bulk", json={"pans": pans[i:i + 200], "purpose": "Loan underwriting"},
                  headers={"X-API-Key": conn.password}, timeout=180)
```

**See also.** [Consent (AA)](#consent), [FIP (financial information provider)](#fip), [Purge with SHA-256 proof](#purge-proof)

<a id="approve-refer-decline"></a>
### Approve / Refer / Decline

Approve means a pre-approved offer. Refer means an offer that a credit committee reviews first. Decline means no offer.

**In Exasol.** DECLINE on any hard fail. REFER when KYC is not verified, no GST returns are on file (GST_TURNOVER_12M is 0 or GST_LATE_FILINGS_12M is null, reason "No GST returns on file"), the grade is C2 or D, the offer is under half the indicated need, the hurdle needs a rate above the rate card, or the anomaly model flagged the company. Otherwise APPROVE.

**Objects.** `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CASE WHEN FAILS IS NOT NULL THEN 'DECLINE'
     WHEN KYC_STATUS <> 'VERIFIED' OR GST_TURNOVER_12M = 0 OR GST_LATE_FILINGS_12M IS NULL  -- no GST returns on file means a person looks first, never a decline
          OR GRADE IN ('C2', 'D') OR OFFER_AMT < AMOUNT_REQUESTED * 0.5
          OR FLOOR_ROI_RAW > LIST_ROI
          OR OFFER_AMT <= 0 THEN 'REFER'
     WHEN ANOMALY IS NOT NULL THEN 'REFER'  -- unusual figures: a person looks first; never a decline
     ELSE 'APPROVE' END DECISION,
NULLIF(TRIM(BOTH ';' FROM COALESCE(FAILS, '') ||
       CASE WHEN KYC_STATUS <> 'VERIFIED' THEN ';KYC ' || KYC_STATUS ELSE '' END ||
       CASE WHEN GST_TURNOVER_12M = 0 OR GST_LATE_FILINGS_12M IS NULL THEN ';No GST returns on file' ELSE '' END ||
```

**See also.** [Hard fail](#hard-fail), [KYC](#kyc), [Isolation Forest anomaly flag](#anomaly-flag)

<a id="bounce-ratio"></a>
### Bounce ratio

The share of the company's payments that bounced for lack of funds.

**In Exasol.** FEATURES.BOUNCE_RATIO = bounced debits / all debits over 12 months of Oracle transactions (VS_CBS). Above 8% is a hard fail.

**Objects.** `CREDORA.FEATURES`, `VS_CBS`

**See also.** [Hard fail](#hard-fail), [Pushdown](#pushdown)

<a id="cibil-commercial"></a>
### CIBIL commercial report

The company's own credit report from CIBIL. It shows CMR rank, total exposure, overdue, suits and wilful default.

**In Exasol.** Step 4 calls CREDORA.CIBIL_COMMERCIAL_FETCH through CONNECTION MOCK_CIBIL into CREDORA_STAGE.CIBIL_COMMERCIAL.

**Objects.** `CREDORA.CIBIL_COMMERCIAL_FETCH`, `CREDORA_STAGE.CIBIL_COMMERCIAL`

**See also.** [CMR rank](#cmr-rank), [Wilful default](#wilful-default), [Suit filed](#suit-filed)

<a id="cibil-consumer"></a>
### CIBIL consumer report

A person's credit report from the bureau CIBIL, with score, loans, overdues and payment history. Credora pulls it for every partner of a company.

**In Exasol.** Step 3 calls CREDORA.CIBIL_CONSUMER_FETCH through CONNECTION MOCK_CIBIL into CREDORA_STAGE.CIBIL_CONSUMER. Step 7 derives PARTNER_MIN_SCORE, PARTNER_AVG_SCORE and PARTNER_OVERDUE_AMT.

**Objects.** `CREDORA.CIBIL_CONSUMER_FETCH`, `CREDORA_STAGE.CIBIL_CONSUMER`, `MOCK_CIBIL`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
MIN(CASE WHEN c.SCORE = -1 THEN 650 ELSE c.SCORE END) MIN_SCORE,
```

**See also.** [CIBIL commercial report](#cibil-commercial), [Hard fail](#hard-fail)

<a id="cicra-2005"></a>
### CICRA 2005

The Credit Information Companies (Regulation) Act, 2005. It governs credit bureaus such as CIBIL and how lenders pull and use credit reports, with the customer's consent.

**In Exasol.** The CIBIL UDFs fetch reports only for the bank's own customers and their partners, and every raw reply in CREDORA_STAGE carries PURGE_AT, so the report is kept only as long as the run needs it.

**Objects.** `CREDORA.CIBIL_CONSUMER_FETCH`, `CREDORA.CIBIL_COMMERCIAL_FETCH`, `CREDORA_STAGE.CIBIL_CONSUMER`, `CREDORA_STAGE.CIBIL_COMMERCIAL`

From [`exasol/udf/04_api_udfs.sql`](../exasol/udf/04_api_udfs.sql).

<a id="cmr-rank"></a>
### CMR rank

CIBIL's company credit rank from 1 (best) to 10 (worst).

**In Exasol.** Fetched by CIBIL_COMMERCIAL_FETCH into CREDORA_STAGE.CIBIL_COMMERCIAL and copied to FEATURES.CMR_RANK. Rank 9 or 10 is a hard fail.

**Objects.** `CREDORA_STAGE.CIBIL_COMMERCIAL`, `CREDORA.FEATURES`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CASE WHEN CMR_RANK >= 9 THEN 'CIBIL CMR rank ' || CMR_RANK || ';' ELSE '' END ||
```

**See also.** [CIBIL commercial report](#cibil-commercial), [Hard fail](#hard-fail)

<a id="consent"></a>
### Consent (AA)

The customer's time-limited permission to share account data. When it expires, the data must go.

**In Exasol.** Each AA_ACCOUNT row gets PURGE_AT = the consent expiry (24 hours in the mock), and PURGE_EXPIRED deletes it after that.

**Objects.** `CREDORA_STAGE.AA_ACCOUNT`, `CREDORA.PURGE_EXPIRED`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
COALESCE(consent_expires, ADD_HOURS(SYSTIMESTAMP, 24))
```

**See also.** [Account Aggregator (AA)](#account-aggregator), [Purge with SHA-256 proof](#purge-proof)

<a id="disbursal"></a>
### Disbursal

Paying the sanctioned loan money into the customer's account. Credora tracks it as a status only. It moves no money.

**See also.** [Loan status tracking](#loan-status), [Offer stages](#offer-stages)

<a id="dscr"></a>
### DSCR

Debt service coverage ratio. It is the cash the business earns divided by the loan payments due. Above 1 means it can pay.

**In Exasol.** A feature in CREDORA.FEATURES, computed as 12% of 12-month GST turnover over the yearly payment on the indicated need at 11%. The offer amount keeps DSCR at least MIN_DSCR (1.25). The negotiation limit keeps it at least NEGOTIATION_DSCR (1.10).

**Objects.** `CREDORA.FEATURES`, `CREDORA.CONFIG`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
COALESCE(gst.TURNOVER, 0) * 0.12 /
  CASE WHEN app.PRODUCT = 'TL'
       THEN 12 * app.AMOUNT_REQUESTED * (0.11 / 12) / (1 - POWER(1 + 0.11 / 12, -app.TENURE_REQUESTED))
       ELSE app.AMOUNT_REQUESTED * 0.11 END,
```

**See also.** [Negotiation limit](#negotiation-limit), [GST returns](#gst-returns)

<a id="eblr"></a>
### EBLR

External benchmark lending rate. It is the base interest rate, linked to the central bank's repo rate, on which loan rates are built.

**In Exasol.** CONFIG EBLR_PCT, 8.25% by default. Every offer rate starts from it.

**Objects.** `CREDORA.CONFIG`

From [`exasol/sql/01_schemas.sql`](../exasol/sql/01_schemas.sql).

```sql
SELECT 'EBLR_PCT' k, 8.25 v, 'External benchmark lending rate (repo-linked), % p.a.' d FROM DUAL UNION ALL
SELECT 'OPERATING_SPREAD_PCT', 0.75, 'Operating spread added to every loan, % p.a.' FROM DUAL UNION ALL
```

**See also.** [Spread](#spread), [Floor ROI](#floor-roi), [ROI (rate of interest)](#roi)

<a id="expected-loss"></a>
### Expected loss

The loss to expect on average, PD x LGD x amount.

**In Exasol.** Certified metric expected_loss in CREDORA_SEM.PORTFOLIO, summed over offers.

**Objects.** `CREDORA_SEM.PORTFOLIO`

**See also.** [PD (probability of default)](#pd), [LGD (loss given default)](#lgd), [Certified metric](#certified-metric)

<a id="fip"></a>
### FIP (financial information provider)

The bank or institution that holds the account and sends its data through the Account Aggregator.

**In Exasol.** Stored in CREDORA_STAGE.AA_ACCOUNT.FIP, for example HDFC Bank.

**Objects.** `CREDORA_STAGE.AA_ACCOUNT`

**See also.** [Account Aggregator (AA)](#account-aggregator)

<a id="floor-roi"></a>
### Floor ROI

The lowest rate the RM may agree to in negotiation.

**In Exasol.** The higher of EBLR + FLOOR_MARGIN_PCT and the rate at which RAROC equals the hurdle, rounded up to 0.05%. Stored as DECISIONS.FLOOR_ROI.

**Objects.** `CREDORA.DECISIONS`, `CREDORA.CONFIG`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CEIL((GREATEST(EBLR + FLOOR_MARGIN, HURDLE * CAPITAL / 100 + FUNDS + OPEX + PD * LGD)) * 20) / 20 FLOOR_ROI_RAW,
```

**See also.** [Negotiation limit](#negotiation-limit), [Hurdle rate](#hurdle-rate), [RAROC](#raroc)

<a id="gst-returns"></a>
### GST returns

The monthly tax filings a business makes. They show its sales and whether it files on time.

**In Exasol.** Step 7 uses the last 12 returns before the credit need was recorded. GST_TURNOVER_12M comes from GSTR-1 and GST_LATE_FILINGS_12M from filed and due dates. 4 or more late returns is a hard fail.

**Objects.** `CREDORA_STAGE.GST_FILING`, `CREDORA.FEATURES`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
SUM(CASE WHEN FILED_ON IS NULL OR FILED_ON > DUE_DATE THEN 1 ELSE 0 END) LATE,
```

**See also.** [GSTR-1](#gstr-1), [GSTR-3B](#gstr-3b), [GST vs bank gap](#gst-bank-gap)

<a id="gst-bank-gap"></a>
### GST vs bank gap

How far the sales declared for GST differ from the money that actually came into the bank account. A big gap is a warning sign.

**In Exasol.** FEATURES.GST_BANK_GAP_PCT compares GST turnover with Oracle current-account credits read through VS_CBS. The anomaly model also compares the two.

**Objects.** `CREDORA.FEATURES`, `VS_CBS`

**See also.** [GST returns](#gst-returns), [Isolation Forest anomaly flag](#anomaly-flag), [Pushdown](#pushdown)

<a id="gstn"></a>
### GSTN

The Goods and Services Tax Network, India's system where businesses register for GST and file their returns.

**In Exasol.** Step 5 calls CREDORA.GST_FETCH through CONNECTION MOCK_GSTN (the gst.credora.link relay) into CREDORA_STAGE.GST_FILING.

**Objects.** `CREDORA.GST_FETCH`, `MOCK_GSTN`, `CREDORA_STAGE.GST_FILING`

**See also.** [GST returns](#gst-returns), [GSTR-1](#gstr-1), [GSTR-3B](#gstr-3b)

<a id="gstr-1"></a>
### GSTR-1

The GST return that lists a business's sales for the month.

**In Exasol.** Stored as GST_FILING.GSTR1_TURNOVER. Its 12-month sum is FEATURES.GST_TURNOVER_12M.

**Objects.** `CREDORA_STAGE.GST_FILING`

**See also.** [GST returns](#gst-returns), [GSTR-3B](#gstr-3b)

<a id="gstr-3b"></a>
### GSTR-3B

The monthly GST summary return in which the business declares and pays its tax.

**In Exasol.** Stored as GST_FILING.GSTR3B_TAX_PAID.

**Objects.** `CREDORA_STAGE.GST_FILING`

**See also.** [GST returns](#gst-returns), [GSTR-1](#gstr-1)

<a id="hard-fail"></a>
### Hard fail

A policy rule that blocks an offer whatever the model says.

**In Exasol.** Wilful defaulter, CMR rank 9 or 10, 4 or more late GST returns in 12 months (only when GST_LATE_FILINGS_12M is not null), a partner's CIBIL score below 600, or a bounce ratio above 8% gives DECLINE. A company with no GST returns on file is never declined for it. It is REFERRED with the reason "No GST returns on file". The reasons are stored in DECISIONS.HARD_FAILS.

**Objects.** `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CASE WHEN WILFUL_DEFAULT THEN 'Wilful defaulter;' ELSE '' END ||
CASE WHEN CMR_RANK >= 9 THEN 'CIBIL CMR rank ' || CMR_RANK || ';' ELSE '' END ||
CASE WHEN GST_LATE_FILINGS_12M IS NOT NULL AND GST_LATE_FILINGS_12M >= 4
     THEN GST_LATE_FILINGS_12M || ' late GST returns in 12 months;' ELSE '' END ||
CASE WHEN PARTNER_MIN_SCORE < 600 THEN 'Partner CIBIL ' || PARTNER_MIN_SCORE || ' below 600;' ELSE '' END ||
CASE WHEN BOUNCE_RATIO > 0.08 THEN 'Bounce ratio ' || ROUND(BOUNCE_RATIO * 100, 1) || '%;' ELSE '' END), '') FAILS
```

**See also.** [Approve / Refer / Decline](#approve-refer-decline), [Wilful default](#wilful-default), [CMR rank](#cmr-rank)

<a id="hurdle-rate"></a>
### Hurdle rate

The minimum RAROC the bank accepts on any loan. Below it, the loan is not worth the capital.

**In Exasol.** CONFIG HURDLE_PCT, 15% by default. The floor ROI is set so RAROC at the floor still meets it. The RM's quote checks RAROC against it.

**Objects.** `CREDORA.CONFIG`

From [`exasol/sql/01_schemas.sql`](../exasol/sql/01_schemas.sql).

```sql
SELECT 'HURDLE_PCT', 15.00, 'Minimum RAROC the bank accepts, %' FROM DUAL UNION ALL
```

**See also.** [RAROC](#raroc), [Floor ROI](#floor-roi), [CREDORA.CONFIG (policy knobs)](#policy-config)

<a id="indicated-need"></a>
### Indicated need / credit need on file

What the company has told the bank it might need, with product, amount, tenure and purpose. It is the starting point, and the offer can be smaller.

**In Exasol.** Read live from PostgreSQL through VS_LOS."application" in step 2 (Read credit needs on file) and stored in CREDORA.APPLICATIONS (AMOUNT_REQUESTED, TENURE_REQUESTED, PRODUCT).

**Objects.** `VS_LOS`, `CREDORA.APPLICATIONS`

**See also.** [Pre-approved offer](#pre-approved-offer), [Working capital (WC)](#working-capital), [Term loan (TL)](#term-loan)

<a id="kfs"></a>
### KFS (Key Facts Statement)

A one-page statement of the loan's cost that a lender gives the borrower before the loan, with the rate, fees and the annual percentage rate (APR).

**In Exasol.** Not implemented. The offer in CREDORA.DECISIONS has an amount, ROI and tenure, and no KFS or APR fields. They would be needed before a real customer saw the offer.

**Objects.** `CREDORA.DECISIONS`

<a id="kyc"></a>
### KYC

Know your customer, the bank's identity checks. A company whose KYC is not verified cannot get a pre-approved offer.

**In Exasol.** KYC_STATUS comes from the MySQL customer master through VS_CIF. Anything other than VERIFIED gives REFER.

**Objects.** `VS_CIF`, `CREDORA.APPLICATIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
WHEN KYC_STATUS <> 'VERIFIED' OR GRADE IN ('C2', 'D') OR OFFER_AMT < AMOUNT_REQUESTED * 0.5
```

**See also.** [Approve / Refer / Decline](#approve-refer-decline)

<a id="lgd"></a>
### LGD (loss given default)

If a borrower defaults, the share of the loan the bank expects to lose after recovery.

**In Exasol.** CONFIG LGD_PCT, 45% by default. Used in RAROC, the floor ROI and the certified metric expected_loss.

**Objects.** `CREDORA.CONFIG`

**See also.** [Expected loss](#expected-loss), [RAROC](#raroc)

<a id="loan-operations"></a>
### Loan operations

The back-office team that checks the agreed terms and sanctions the loan.

**In Exasol.** Signs in as CREDORA_LOANOPS (role R_LOANOPS) and reads all of CREDORA and the bank databases, but not CREDORA_STAGE. Runs the analysis, verifies and sanctions, and assigns companies to RMs.

**Objects.** `CREDORA_LOANOPS`, `R_LOANOPS`

**See also.** [Maker-checker](#maker-checker), [Schema-level grant](#schema-grant), [RM assignment](#rm-assignment)

<a id="maker-checker"></a>
### Maker-checker

One person makes a change and a second person checks and approves it. No one can push a decision through alone.

**In Exasol.** For offers, the RM proposes terms and loan operations verifies and sanctions. For policy, the data scientist proposes and the admin approves. Each step is a separate login and a separate Exasol user.

**See also.** [Offer stages](#offer-stages), [Policy proposal](#policy-proposal), [Model activation approval](#model-activation-approval)

<a id="model-risk-management"></a>
### Model risk management

How a bank controls the risk that a credit model is wrong. The RBI's 2024 guidance on model risk management for credit asks for validation, a record of each model, and approval before a model is used.

**In Exasol.** TRAIN_MODEL trains the champion and the challenger on the same loans and the same hold-out and records both in MODEL_REGISTRY with AUC, Gini and a SHA-256 of the model file. The challenger is scored in the shadow on every run, and a version decides nothing until the admin approves its activation.

**Objects.** `CREDORA.TRAIN_MODEL`, `CREDORA.MODEL_REGISTRY`, `CREDORA.CHALLENGER_SCORES`

From [`exasol/udf/05_ml_udfs.sql`](../exasol/udf/05_ml_udfs.sql).

<a id="nayak-committee"></a>
### Nayak committee (turnover method)

An RBI committee whose turnover method sizes a working-capital limit as a share of the borrower's annual turnover.

**In Exasol.** The policy key MAX_GST_SHARE_PCT in CREDORA.CONFIG (20% by default) caps the working-capital offer as a share of the company's 12-month GST turnover. DSCR caps it again.

**Objects.** `CREDORA.CONFIG`, `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

<a id="negotiation-limit"></a>
### Negotiation limit

How far the RM may move without going back to credit, set as the lowest rate, highest amount and longest tenure.

**In Exasol.** Stored per company as FLOOR_ROI, MAX_AMOUNT (at most 1.15 x the indicated need, with DSCR at least NEGOTIATION_DSCR) and MAX_TENURE in CREDORA.DECISIONS. A proposal outside it is ESCALATED.

**Objects.** `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
FLOOR(LEAST(AMOUNT_REQUESTED * 1.15, GREATEST(CAP_MAX, 0)) / 100000) * 100000 MAX_AMT,
```

**See also.** [Floor ROI](#floor-roi), [DSCR](#dscr), [Offer stages](#offer-stages)

<a id="pan-gstin"></a>
### PAN and GSTIN

PAN is India's tax ID for a person or company. GSTIN is the GST registration number, which contains the PAN.

**In Exasol.** CIBIL is fetched by PAN and GST by GSTIN. V_COMPANY_MASKED shows only their last characters. The V_RM_COMPANY view shows them in full for assigned companies only.

**Objects.** `CREDORA.V_COMPANY_MASKED`, `CREDORA.V_RM_COMPANY`

**See also.** [Masked company view](#masked-view), [Row-level security view](#row-level-security)

<a id="pd"></a>
### PD (probability of default)

The chance, from 0 to 1, that the company will not repay. 0.03 means 3 in 100 similar companies default.

**In Exasol.** PD_SCORE writes it to CREDORA.SCORES.PD in step 9. It drives the grade, the expected loss and the rate.

**Objects.** `CREDORA.SCORES`, `CREDORA.PD_SCORE`

**See also.** [Risk grade](#grade), [Risk model (champion)](#risk-model), [LGD (loss given default)](#lgd), [RAROC](#raroc)

<a id="pre-approved-offer"></a>
### Pre-approved offer

The bank approaches an existing customer with a loan already decided (an amount, a rate and a tenure) before the customer comes in.

**In Exasol.** A decision of APPROVE in CREDORA.DECISIONS with OFFER_AMOUNT, OFFER_ROI and OFFER_TENURE. The certified metric pre_approved_amount sums them.

**Objects.** `CREDORA.DECISIONS`, `CREDORA_SEM.PORTFOLIO`

From [`exasol/semantic/12_credora_model.sql`](../exasol/semantic/12_credora_model.sql).

```sql
METRIC pre_approved_amount AS SUM(offer_amount) ON ENTITY decision RETURNS DECIMAL(18,2)
  FILTER (WHERE decision = ''APPROVE'')
  FORMAT ''currency'' DISPLAY ''Pre-approved amount'' COMMENT ''Sum of pre-approved offer amounts (APPROVE only), INR''
```

**See also.** [Indicated need / credit need on file](#indicated-need), [Negotiation limit](#negotiation-limit), [Approve / Refer / Decline](#approve-refer-decline)

<a id="rank"></a>
### Rank

The order in which offers are worth pursuing, 1 being best.

**In Exasol.** DECISIONS.RANK_NO orders approved before referred before declined, then by skyline layer, PD and RAROC.

**Objects.** `CREDORA.DECISIONS`

**See also.** [Top 50](#top-50), [PREFERRING (skyline)](#preferring-skyline)

<a id="raroc"></a>
### RAROC

Risk-adjusted return on capital. It is what the loan earns after funding cost, running cost and expected loss, divided by the capital the bank must hold.

**In Exasol.** Computed in the decision step as (ROI - FUNDS_COST_PCT - OPEX_PCT - PD x LGD_PCT) / CAPITAL_PCT x 100, at the offer rate (RAROC_OFFER) and at the floor rate (RAROC_FLOOR).

**Objects.** `CREDORA.DECISIONS`, `CREDORA.CONFIG`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
ROUND((OFFER_ROI_RAW - FUNDS - OPEX - PD * LGD) / CAPITAL * 100, 3),
```

**See also.** [Hurdle rate](#hurdle-rate), [Floor ROI](#floor-roi), [PD (probability of default)](#pd), [LGD (loss given default)](#lgd)

<a id="grade"></a>
### Risk grade

A letter grade from the PD. A1 is safest, then A2, B1, B2, C1, C2 and D.

**In Exasol.** Set in SQL in step 9. A1 is below 1%, A2 below 2%, B1 below 3.5%, B2 below 5%, C1 below 8%, C2 below 12%, and anything else is D. Grades C2 and D are referred.

**Objects.** `CREDORA.SCORES`, `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
     WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END
```

**See also.** [PD (probability of default)](#pd), [Spread](#spread)

<a id="rm"></a>
### RM (relationship manager)

The banker who owns the relationship with a set of companies, makes the offer and negotiates.

**In Exasol.** Signs in as Exasol user CREDORA_RM (role R_RM). Sees only assigned companies through the V_RM_* views and negotiates inside the negotiation limit.

**Objects.** `CREDORA_RM`, `R_RM`, `CREDORA.RM_ASSIGNMENT`

**See also.** [RM assignment](#rm-assignment), [Row-level security view](#row-level-security), [Negotiation limit](#negotiation-limit)

<a id="roi"></a>
### ROI (rate of interest)

The yearly interest rate on the loan, in % per year.

**In Exasol.** OFFER_ROI in CREDORA.DECISIONS is the rate-card rate, raised to the floor ROI if the floor is higher.

**Objects.** `CREDORA.DECISIONS`

**See also.** [Spread](#spread), [Floor ROI](#floor-roi)

<a id="spread"></a>
### Spread

The extra interest added on top of the base rate to pay for risk and running costs.

**In Exasol.** Offer rate = EBLR + risk spread by grade (1.00% for A1 up to 7.00% for D) + operating spread 0.75%, minus 0.25% when collateral covers the amount.

**Objects.** `CREDORA.CONFIG`, `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CASE s.GRADE WHEN 'A1' THEN 1.00 WHEN 'A2' THEN 1.50 WHEN 'B1' THEN 2.25 WHEN 'B2' THEN 3.00
             WHEN 'C1' THEN 4.00 WHEN 'C2' THEN 5.25 ELSE 7.00 END RISK_SPREAD,
```

**See also.** [EBLR](#eblr), [Risk grade](#grade), [ROI (rate of interest)](#roi)

<a id="suit-filed"></a>
### Suit filed

A lender has gone to court to recover money from the company.

**In Exasol.** From the CIBIL commercial report into FEATURES.SUIT_FILED and shown in the report. It is not one of the hard-fail rules.

**Objects.** `CREDORA.FEATURES`

**See also.** [CIBIL commercial report](#cibil-commercial), [Wilful default](#wilful-default)

<a id="term-loan"></a>
### Term loan (TL)

A loan for a fixed period, repaid in monthly instalments (EMI), usually to buy equipment or expand.

**In Exasol.** PRODUCT = 'TL'. Tenure is capped at 84 months (60 for grades C1, C2 and D). The amount is sized so the EMI keeps DSCR at least MIN_DSCR.

**Objects.** `CREDORA.DECISIONS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
CASE WHEN a.PRODUCT = 'TL'
     THEN LEAST(a.TENURE_REQUESTED, CASE WHEN s.GRADE IN ('C1', 'C2', 'D') THEN 60 ELSE 84 END)
     ELSE 12 END TENURE_OFFER
```

**See also.** [Working capital (WC)](#working-capital), [DSCR](#dscr)

<a id="top-50"></a>
### Top 50

The 50 best pre-approved offers of a run, the ones RMs should call first.

**In Exasol.** DECISIONS.TOP50 = TRUE for the 50 best-ranked APPROVE rows after the PREFERRING skyline layers and ROW_NUMBER().

**Objects.** `CREDORA.DECISIONS`

**See also.** [PREFERRING (skyline)](#preferring-skyline), [Rank](#rank)

<a id="wilful-default"></a>
### Wilful default

A borrower that could pay but chose not to. Banks do not lend to wilful defaulters.

**In Exasol.** From the CIBIL commercial report into FEATURES.WILFUL_DEFAULT. A wilful defaulter is a hard fail and is declined.

**Objects.** `CREDORA.FEATURES`, `CREDORA_STAGE.CIBIL_COMMERCIAL`

**See also.** [Hard fail](#hard-fail), [CIBIL commercial report](#cibil-commercial)

<a id="working-capital"></a>
### Working capital (WC)

A short-term credit line, usually for 12 months, to fund day-to-day stock and receivables. Interest is paid on what is used.

**In Exasol.** PRODUCT = 'WC'. The offer is capped at MAX_GST_SHARE_PCT (20%) of 12-month GST turnover and by DSCR. Tenure is 12 months.

**Objects.** `CREDORA.DECISIONS`, `CREDORA.CONFIG`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```sql
ELSE LEAST(GST_TURNOVER_12M * GST_SHARE / 100, CASH / MIN_DSCR / (GREATEST(LIST_ROI, FLOOR_ROI_RAW) / 100))
```

**See also.** [Term loan (TL)](#term-loan), [DSCR](#dscr)

## AI

<a id="ask-credora"></a>
### Ask Credora

Plain-English questions about the analysis, answered by Claude with the exact SQL it ran.

**In Exasol.** Answers come from the semantic view CREDORA_SEM.PORTFOLIO first, then plain SQL where the role's grants allow. The MCP server logs in as the person's own AI session user (CREDORA_RM_AI for the relationship manager), which holds the same role as the person, so Exasol decides what the AI can read.

**Objects.** `CREDORA_SEM.PORTFOLIO`, `CREDORA_ADMIN_AI`, `CREDORA_RM_AI`

**See also.** [Exasol MCP server](#exasol-mcp-server), [Ask Credora topic gate](#topic-gate), [Semantic view (exasol-semantic-views)](#semantic-view), [MCP tool call](#mcp-tool-call)

<a id="topic-gate"></a>
### Ask Credora topic gate

A quick check that refuses questions that are not about Credora's analysis, before any data is touched.

**In Exasol.** _on_topic() makes one Claude call that must reply IN or OUT. An OUT question gets a fixed refusal and no MCP server is started, so it never reaches Exasol.

From [`backend/app/assistant.py`](../backend/app/assistant.py).

```python
async def _on_topic(client: Any, question: str) -> bool:
    """A one-word classification call before any tool use; unrelated questions never reach Exasol."""
    try:
        resp = await asyncio.to_thread(
            client.messages.create, model=settings.ai_model, max_tokens=5, system=SCOPE_PROMPT,
            messages=[{"role": "user", "content": question}])
    except Exception as e:  # noqa: BLE001 - if the filter itself fails, the main prompt's scope rule decides
        log.warning("topic check failed: %s", e)
        return True
    verdict = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip().upper()
    return not verdict.startswith("OUT")
```

**See also.** [Ask Credora](#ask-credora), [Exasol MCP server](#exasol-mcp-server)

<a id="claude"></a>
### Claude

Anthropic's AI model. In Credora it answers plain-English questions and writes short credit memos.

**In Exasol.** Claude never connects to Exasol directly. It reads data only through Exasol MCP server tool calls as the person's AI session user, or receives the facts inside the CREDIT_MEMO UDF.

**Objects.** `AI_LLM`, `CREDORA.CREDIT_MEMO`

**See also.** [Credit memo UDF (CONNECTION AI_LLM)](#credit-memo-udf), [Ask Credora](#ask-credora), [MCP tool call](#mcp-tool-call)

<a id="credit-memo-udf"></a>
### Credit memo UDF (CONNECTION AI_LLM)

A short memo for the relationship manager in four lines, headed Decision, Why, Watch and Negotiate. Written by Claude from the company's numbers only.

**In Exasol.** CREDORA.CREDIT_MEMO is a Python SCALAR UDF that calls the Claude API with the key held in CONNECTION AI_LLM (only R_SVC has ACCESS). The backend runs it as CREDORA_SVC and stores the result in CREDORA.MEMOS with engine exasol-udf. On Bedrock the backend calls the model itself (engine backend).

**Objects.** `CREDORA.CREDIT_MEMO`, `AI_LLM`, `CREDORA.MEMOS`

From [`exasol/udf/09_ai_udf.sql`](../exasol/udf/09_ai_udf.sql).

```python
def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    r = requests.post(
        f"{conn.address}/v1/messages",
        headers={"x-api-key": conn.password, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": ctx.model, "max_tokens": 400, "system": SYSTEM,
              "messages": [{"role": "user", "content": ctx.facts}]},
        timeout=60,
```

**Exasol docs.** https://docs.exasol.com/db/latest/database_concepts/udf_scripts/python3.htm

**See also.** [Claude](#claude), [CONNECTION object](#connection-object), [SCALAR vs SET UDF](#scalar-vs-set-udf)

<a id="mcp-tool-call"></a>
### MCP tool call

When the AI needs data, it calls a named tool (for example 'run this query') and reads the result before answering.

**In Exasol.** Claude calls tools such as execute_exasol_query and describe_exasol_tables_and_views on the Exasol MCP server, at most 8 per question. Every call and its SQL is returned with the answer and shown on screen.

**Objects.** `CREDORA_SEM.PORTFOLIO`, `CREDORA.DECISIONS`

From [`backend/app/assistant.py`](../backend/app/assistant.py).

```python
calls += 1
try:
    r = await asyncio.wait_for(session.call_tool(b.name, b.input or {}), timeout=120)
    text, is_error = result_text(r), bool(getattr(r, "isError", False))
except asyncio.TimeoutError:
    text, is_error = "The query took too long.", True
```

**See also.** [Exasol MCP server](#exasol-mcp-server), [Ask Credora](#ask-credora)

<a id="risk-model"></a>
### Risk model (champion)

A machine-learning model trained on the bank's 5,000 past loans that estimates how likely each company is to default.

**In Exasol.** CREDORA.TRAIN_PD trains gradient-boosted trees (scikit-learn HistGradientBoosting with monotonic constraints) in a Python UDF on VS_LOS."past_loan_training", read live from PostgreSQL. Step 9 scores every company with CREDORA.PD_SCORE, which checks the model file's SHA-256 against MODEL_REGISTRY before unpickling and also returns each feature's effect on the PD.

**Objects.** `CREDORA.TRAIN_PD`, `CREDORA.PD_SCORE`, `CREDORA.SCORES`, `VS_LOS`

From [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql).

```lua
step(9, 'Score probability of default (ML UDF)', function()
  return rows(query([[
    INSERT INTO CREDORA.SCORES
    SELECT :r, app_id, :mv, pd,
           CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
                WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END,
           contributions
    FROM (SELECT CREDORA.PD_SCORE(:mp, :mh, APP_ID, GST_YEARS, GST_TURNOVER_12M, GST_LATE_FILINGS_12M, GST_BANK_GAP_PCT,
                                  AVG_BALANCE_12M, INFLOW_VOLATILITY, BOUNCE_RATIO, CMR_RANK, PARTNER_MIN_SCORE,
                                  PARTNER_AVG_SCORE, PARTNER_OVERDUE_AMT, PARTNER_OTHER_BANK_BAL, DSCR)
          FROM CREDORA.FEATURES WHERE RUN_ID = :r GROUP BY MOD(ASCII(SUBSTR(HASH_MD5(APP_ID), 1, 1)), 4))]],
    {r = run_id, mv = model_version, mp = model_path, mh = model_sha256}))
```

**See also.** [PD (probability of default)](#pd), [Risk grade](#grade), [MODEL_REGISTRY](#model-registry), [Challenger scorecard model](#challenger-model)

## AWS

<a id="rds"></a>
### Amazon RDS (Oracle, MySQL, PostgreSQL)

Managed databases on AWS. They stand in for Sapphire Bank's real systems.

**In Exasol.** RDS for Oracle holds core banking (schema CBS), MySQL holds the customer master (cif) and PostgreSQL holds loan origination (los) and the CRM (crm). Exasol reads the first three through VS_CBS, VS_CIF and VS_LOS as read-only database users. The databases sit in private subnets.

**Objects.** `VS_CBS`, `VS_CIF`, `VS_LOS`, `ORA_CBS`, `MYSQL_CIF`, `PG_LOS`

**See also.** [Virtual schema](#virtual-schema), [CRM (PostgreSQL crm)](#crm)

<a id="secrets-manager"></a>
### AWS Secrets Manager

AWS's safe for passwords and keys.

**In Exasol.** OpenTofu generates each deployment's runtime secret there. The deploy tool reads it to set the Exasol users' passwords and to fill the CONNECTION objects, so no secret is in the repo.

**Objects.** `CREDORA_SVC`, `ORA_CBS`

**See also.** [Exasol user](#user), [CONNECTION object](#connection-object)

<a id="ec2-app-host"></a>
### EC2 app host

The AWS server that runs the web app, its API, the mock CIBIL, GSTN and Account Aggregator services and the data generator.

**In Exasol.** It is separate from the Exasol EC2 instance. The backend on it connects to Exasol on port 8563 with pyexasol, one session pool per Exasol user.

**Objects.** `CREDORA_SVC`, `CREDORA_ADMIN`

**See also.** [Exasol Personal on AWS](#exasol-personal-aws), [Sessions](#sessions)

<a id="route53"></a>
### Route 53 (credora.loan, credora.link)

AWS's DNS service. It points the web addresses to the right servers.

**In Exasol.** credora.loan serves the app. credora.link serves the 3rd party data APIs (CIBIL, GSTN, Account Aggregator). cibil., gst. and aa.credora.link are the HTTPS relays that the MOCK_CIBIL, MOCK_GSTN and MOCK_AA connections call to fetch 3rd party data on demand via API.

**Objects.** `MOCK_CIBIL`, `MOCK_GSTN`, `MOCK_AA`

**See also.** [CONNECTION object](#connection-object), [EC2 app host](#ec2-app-host)

## The Credora app

<a id="audit-log"></a>
### Audit log

A record of who did what and when, covering logins, runs, reports viewed, proposals and approvals.

**In Exasol.** There are two logs. The app's log is crm.audit_event, which the backend writes for each action (for example RUN_ANALYSIS, TRAIN_MODEL, VIEW_REPORT, ASK_CREDORA) and shows under Audit and purge. The database's log is Exasol's own audit log (EXA_DBA_AUDIT_SQL, EXA_DBA_AUDIT_SESSIONS), which records every statement and is shown under Exasol audit. The purge proof is separate, in CREDORA.PURGE_LOG.

**Objects.** `CREDORA.PURGE_LOG`, `EXA_DBA_AUDIT_SQL`, `EXA_DBA_AUDIT_SESSIONS`

**See also.** [Purge with SHA-256 proof](#purge-proof), [CRM (PostgreSQL crm)](#crm), [Exasol audit log](#exasol-audit)

<a id="crm"></a>
### CRM (PostgreSQL crm)

Sapphire Bank's offer tracker. It holds every offer, who changed it, and the audit log.

**In Exasol.** After each analysis the backend reads CREDORA.DECISIONS as CREDORA_SVC and upserts crm.offer in PostgreSQL. Negotiation and checker actions change crm.offer and crm.offer_event, not Exasol.

**Objects.** `CREDORA.DECISIONS`

**See also.** [Offer stages](#offer-stages), [Amazon RDS (Oracle, MySQL, PostgreSQL)](#rds)

<a id="exasol-console"></a>
### Exasol console

A drawer at the bottom of the screen that lists, live, every statement the backend ran in Exasol for this browser tab.

**In Exasol.** backend/app/exa.py records each statement with the Exasol user it ran as, its time in milliseconds, its row count and any error, in a small ring buffer per signed-in person (the latest 200). Jobs add their RUN_LOG steps and model registry switches. Ask Credora adds each MCP tool call. Passwords and secret-looking literals are masked before anything is kept. The browser polls GET /api/exasol/console for its own entries only. The admin may also see everyone's.

**Objects.** `CREDORA_ADMIN`, `CREDORA_DATASCI`, `CREDORA_LOANOPS`, `CREDORA_RM`, `CREDORA_SVC`

```python
# backend/app/exa.py
def _trace(conn, user, sql, params, t0, rows, error=None):
    shown = conn.format.format(sql, **params) if params else sql
    console.statement(user, shown, (time.perf_counter() - t0) * 1000, rows, error)
```

**See also.** [Sessions](#sessions), [Exasol user](#user), [RUN_LOG](#run-log), [MCP tool call](#mcp-tool-call)

<a id="control-room"></a>
### Exasol control room

A live map of the database. It shows schemas, virtual schemas, scripts and their language containers, connections, the model registry, roles and grants, the preprocessor, the semantic model and the latest run.

**In Exasol.** GET /api/exasol/control-room reads Exasol's system tables (EXA_ALL_SCHEMAS, EXA_ALL_OBJECTS, EXA_ALL_VIRTUAL_SCHEMAS, EXA_ALL_SCRIPTS, EXA_ALL_CONNECTIONS, EXA_PARAMETERS, SEMANTIC_CATALOG) as the signed-in role's own Exasol user, so each role sees what its grants allow. The admin also reads EXA_DBA_* and EXA_DBA_SESSIONS through SELECT ANY DICTIONARY, granted to the user CREDORA_ADMIN only. The panel "Row-level security, proven by Exasol" (GET /api/admin/rls-proof, admin and data scientist) runs one count as CREDORA_RM, CREDORA_RM_AI and CREDORA_RM002 and shows Exasol refusing CREDORA_RM on CREDORA.DECISIONS. Cached for a few seconds per role.

**Objects.** `EXA_ALL_SCHEMAS`, `EXA_ALL_OBJECTS`, `EXA_ALL_VIRTUAL_SCHEMAS`, `EXA_ALL_SCRIPTS`, `EXA_DBA_SESSIONS`

**See also.** [System tables (EXA_ALL_*, EXA_DBA_*)](#system-tables), [SELECT ANY DICTIONARY](#select-any-dictionary), [Explain mode](#explain-mode)

<a id="exasol-report"></a>
### Exasol report

One page per company that shows the decision, why, the features the model saw, the sources used and every step Exasol ran.

**In Exasol.** Read as the signed-in role's Exasol user from DECISIONS, SCORES (CONTRIBUTIONS), FEATURES, ANOMALY and RUN_LOG of the current run. An RM reads the row-filtered V_RM_* views instead.

**Objects.** `CREDORA.DECISIONS`, `CREDORA.SCORES`, `CREDORA.RUN_LOG`

**See also.** [RUN_LOG](#run-log), [Credit memo UDF (CONNECTION AI_LLM)](#credit-memo-udf)

<a id="explain-mode"></a>
### Explain mode

A switch in the top bar that shows what Exasol does behind every screen, with hints next to numbers, a band under each page header, a note for each action and the live Exasol console. Off, Credora looks like a plain CRM.

**In Exasol.** Nothing changes in Exasol. Explain mode only shows what already happens. The choice is remembered per viewer in the browser.

**See also.** [Exasol console](#exasol-console), [Exasol control room](#control-room), [Exasol user](#user)

<a id="loan-status"></a>
### Loan status tracking

After the offer, the relationship manager records what happened. The statuses are Contacted, Negotiating, Loan taken, In progress, then Disbursed or Not interested.

**In Exasol.** Each change is a new row in CREDORA.LOAN_STATUS_LOG, written as CREDORA_SVC with a note, who and when. The newest row is the current status. The RM reads the history back through the row-filtered view CREDORA.V_RM_LOAN_STATUS. After Disbursed the status no longer changes.

**Objects.** `CREDORA.LOAN_STATUS_LOG`, `CREDORA.V_RM_LOAN_STATUS`

From [`exasol/sql/13_rm_row_security.sql`](../exasol/sql/13_rm_row_security.sql).

```sql
CREATE OR REPLACE VIEW CREDORA.V_RM_LOAN_STATUS AS
SELECT l.EVENT_ID, l.CIF_ID, l.RM_ID, l.STATUS, l.NOTE, l.LOGGED_BY, l.LOGGED_AT
FROM CREDORA.LOAN_STATUS_LOG l
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = l.CIF_ID AND a.EXA_USER = REGEXP_REPLACE(CURRENT_USER, '_AI$', '');
```

**See also.** [Offer stages](#offer-stages), [Disbursal](#disbursal)

<a id="mock-data"></a>
### Mock data generator

Builds a fresh synthetic Sapphire Bank with companies, partners, accounts, transactions, GST returns and credit reports. All data is invented.

**In Exasol.** It writes to the RDS databases and the mock API databases, not to Exasol. Exasol sees the new rows through the virtual schemas at the next query, and RUN_ANALYSIS step 1 refreshes their metadata.

**Objects.** `VS_CBS`, `VS_CIF`, `VS_LOS`

**See also.** [Virtual schema](#virtual-schema), [Virtual schema refresh](#vs-refresh)

<a id="model-activation-approval"></a>
### Model activation approval

The data scientist asks to switch the deciding model. The admin approves before it takes effect.

**In Exasol.** Requests live in the CRM (crm.model_activation_request). There is one pending request per version, and nobody decides their own. Approval runs UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE as CREDORA_SVC. It is refused if another model became active after the request.

**Objects.** `CREDORA.MODEL_REGISTRY`

**See also.** [Model activation (IS_ACTIVE)](#model-activation), [Maker-checker](#maker-checker)

<a id="offer-stages"></a>
### Offer stages

Where an offer is in its life. The stages are OFFERED, NEGOTIATING, ESCALATED, VERIFIED, SANCTIONED and DECLINED.

**In Exasol.** Stages live in crm.offer. A new analysis replaces only OFFERED and DECLINED offers. Offers in negotiation or beyond keep their terms.

From [`backend/app/routes/offers.py`](../backend/app/routes/offers.py).

```python
CHECKER = {
    "verify": (("NEGOTIATING", "ESCALATED"), "VERIFIED", "VERIFY"),
    "sanction": (("VERIFIED",), "SANCTIONED", "SANCTION"),
    "reject": (("OFFERED", "NEGOTIATING", "ESCALATED", "VERIFIED"), "DECLINED", "REJECT"),
}
```

**See also.** [Maker-checker](#maker-checker), [CRM (PostgreSQL crm)](#crm), [Loan status tracking](#loan-status)

<a id="policy-proposal"></a>
### Policy proposal

The data scientist proposes new policy numbers from a what-if run. The admin approves or rejects them.

**In Exasol.** Proposals live in crm.policy_proposal. On approval one job runs UPDATE CREDORA.CONFIG as CREDORA_SVC and then a full official CREDORA.RUN_ANALYSIS, so decisions, offers and the semantic layer follow the new policy.

**Objects.** `CREDORA.CONFIG`, `CREDORA.RUN_ANALYSIS`

From [`backend/app/policy.py`](../backend/app/policy.py).

```python
CONFIG_STEP_NAME = "Write the approved policy to CREDORA.CONFIG (as CREDORA_SVC)"
```

**See also.** [What-if](#what-if), [Maker-checker](#maker-checker), [CREDORA.CONFIG (policy knobs)](#policy-config)

<a id="what-if"></a>
### What-if

Try different policy numbers and see at once how many companies would be approved, referred or declined.

**In Exasol.** One SELECT, run as the data scientist's own user CREDORA_DATASCI, replays the decision SQL over the current run's stored FEATURES and SCORES with overridden CONFIG values. Nothing is written to Exasol. Saved runs go to crm.whatif_run.

**Objects.** `CREDORA.CONFIG`, `CREDORA.FEATURES`, `CREDORA.SCORES`, `CREDORA.DECISIONS`

**See also.** [CREDORA.CONFIG (policy knobs)](#policy-config), [Policy proposal](#policy-proposal)

