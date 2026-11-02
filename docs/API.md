# Credora APIs

## Mock 3rd party APIs

The three mock 3rd party APIs (CIBIL, GSTN, Account Aggregator) are FastAPI services. Credora fetches 3rd party data from them on demand via API. Every `/v1/*` call needs the header `X-API-Key: <MOCK_API_TOKEN>`. A missing or wrong key gets `401 {"detail":"missing or invalid X-API-Key"}`. Each service also serves `GET /health` (no key) and an OpenAPI page at `/docs`. Before the first generation, or while the mock database is down, data endpoints and `/status` return `503`.

Bulk endpoints take up to 5,000 keys per call. Duplicates are ignored and results follow the request order. Exasol UDFs should prefer them (one call per few hundred keys) to thousands of single calls.

| Service | Port in Docker network | Path prefix through Caddy |
|---|---|---|
| mock CIBIL | `cibil:8101` | `/mock/cibil/` |
| mock GSTN | `gstn:8102` | `/mock/gstn/` |
| mock AA | `aa:8103` | `/mock/aa/` |

Exasol reaches them on the app host's private IP at ports 8101–8103 (open to the VPC only).

### Mock CIBIL

`GET /v1/consumer/{pan}`
```json
{"pan":"ABCPM1234K","name":"Rohit Mehta","dob":"1979-04-12","score":782,"report_date":"2026-10-31",
 "enquiries_6m":1,"enquiries_12m":2,
 "accounts":[{"lender":"HDFC Bank","acct_type":"Home Loan","opened_on":"2018-06-01","sanctioned":4500000.0,
              "balance":2100000.0,"overdue":0.0,"status":"ACTIVE","dpd_36m":[0,0,0,30,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}]}
```
`404` if the PAN is unknown.

`GET /v1/commercial/{pan}`
```json
{"pan":"AAACS1234K","name":"Shree Ganesh Polymers Pvt Ltd","cmr_rank":3,"report_date":"2026-10-31",
 "total_exposure":32000000.0,"overdue":0.0,"suit_filed":false,"wilful_default":false,"facilities":4}
```

`POST /v1/consumer/bulk` body `{"pans":["ABCPM1234K", ...]}`
```json
{"reports":[{...same shape as GET /v1/consumer/{pan}...}],"not_found":["ZZZZZ9999Z"]}
```

`POST /v1/commercial/bulk` body `{"pans":[...]}` returns `{"reports":[{...same shape as GET /v1/commercial/{pan}...}],"not_found":[...]}`

`GET /status` (no key) returns `{"generated_at":"...","seed":123,"consumer_reports":3511,"commercial_reports":1000}`

### Mock GSTN

`GET /v1/gstin/{gstin}`
```json
{"gstin":"27AAACS1234K1Z5","legal_name":"Shree Ganesh Polymers Pvt Ltd","pan":"AAACS1234K","state":"Maharashtra",
 "registered_on":"2019-04-01","status":"ACTIVE","years_of_filing":7.5,"stage":"Mid-level"}
```

`GET /v1/gstin/{gstin}/returns?from=YYYY-MM&to=YYYY-MM` (all periods by default)
```json
{"gstin":"27AAACS1234K1Z5","returns":[{"period":"2026-09","gstr1_turnover":5230000.0,"gstr3b_tax_paid":941400.0,
 "due_date":"2026-10-20","filed_on":"2026-10-18","delay_days":0}]}
```
Returns are newest first. For a return that was not filed, `filed_on`, `delay_days`, `gstr1_turnover` and `gstr3b_tax_paid` are `null`. `delay_days` = max(0, `filed_on` − `due_date`). `years_of_filing` = number of periods / 12. `stage` is `New` below 5 years, `Mid-level` below 8, else `Stable`. `404` if the GSTIN is unknown, `422` if `from` or `to` is not `YYYY-MM`.

`POST /v1/returns/bulk` body `{"gstins":[...], "from":"YYYY-MM", "to":"YYYY-MM"}` (`from` and `to` optional)
```json
{"items":[{"gstin":"27AAACS1234K1Z5","registration":{...same shape as GET /v1/gstin/{gstin}...},
           "returns":[{...same shape as above...}]}],"not_found":[...]}
```

`GET /status` (no key) returns `{"generated_at":"...","registrations":1000,"filings":61234}`

### Mock Account Aggregator

`POST /v1/consent` body `{"pan":"ABCPM1234K","purpose":"Loan underwriting"}`
```json
{"consent_id":"7a1c...","pan":"ABCPM1234K","status":"ACTIVE","created_at":"...","expires_at":"..."}
```
Consent is approved at once (the mock customer always says yes). It expires after 24 hours.

`GET /v1/fi/{consent_id}`
```json
{"consent_id":"7a1c...","pan":"ABCPM1234K","accounts":[
  {"aa_account_id":"AA00000123","fip":"HDFC Bank","acct_type":"SAVINGS","masked_no":"XXXXXX4521",
   "opened_on":"2015-02-11","current_balance":412500.0,
   "transactions":[{"txn_date":"2026-10-28","dr_cr":"C","amount":85000.0,"narration":"SALARY/NEFT","balance_after":412500.0}]}]}
```
Accounts are ordered by id. Transactions are newest first. `404` if the consent id is unknown, `403` if the consent expired. A PAN with no other-bank accounts still gets a consent, with an empty `accounts` list.

`POST /v1/fi/bulk` body `{"pans":[...], "purpose":"Loan underwriting"}` (`purpose` optional). It creates one consent per PAN and returns the data at once.
```json
{"items":[{"pan":"ABCPM1234K","consent_id":"7a1c...","accounts":[{...same shape as in GET /v1/fi/{consent_id}...}]}]}
```

`GET /status` (no key) returns `{"generated_at":"...","seed":123,"accounts":5210,"transactions":412345,"consents":17}`

### Mock data generator (`generator:8100`, internal only)

| Method and path | Purpose |
|---|---|
| `POST /generate` `{"seed": int or null, "mode": "replace" or "append" (default replace), "companies": 100..5000 (default 1000)}` | `replace` clears and regenerates everything. `append` keeps all data and adds N new companies. Their ids continue from the current maximum, and company names, partner names, PANs, GSTINs and account numbers stay unique. The call returns `202 {job_id, seed, mode, companies}`, `409` while a generation is running and `422` for a bad mode or count. The append steps are prepare, synthesize, oracle, mysql, postgres, mockdb, truth_export |
| `GET /jobs/{job_id}` | `{job_id, kind:"generate", status, progress, steps:[{name,status,detail}], started_at, finished_at, error, seed, mode, companies, counts (totals after the run), added (rows written by this run), timings}`. `GET /last` adds `added`, `mode`, `companies` |
| `GET /last` | the last finished job as `{job_id, seed, status, started_at, finished_at, seconds, counts:{table: rows}, timings:{step: seconds}, error}`, or `404` if there is none |
| `GET /health` | liveness |

The steps are `clear`, `synthesize`, `oracle`, `mysql`, `postgres`, `mockdb`, `truth_export`. The same seed gives the same data on the same day (dates are relative to the generation date).

## Credora backend API (`/api`, FastAPI)

Login returns a bearer token. Each user has one role, which is `admin`, `datasci`, `loanops` or `rm`. Every response that carries data includes a `source` field naming where it came from.

| `source` value | Shown in the UI as |
|---|---|
| `bank.oracle` | Sapphire Bank · Oracle (core banking) |
| `bank.mysql` | Sapphire Bank · MySQL (customer master) |
| `bank.postgres` | Sapphire Bank · PostgreSQL (loans and CRM) |
| `api.cibil` | API · CIBIL (mock) |
| `api.gstn` | API · GSTN (mock) |
| `api.aa` | API · Account Aggregator (mock) |
| `exasol` | Exasol result |

| Method and path | Roles | Purpose |
|---|---|---|
| `POST /api/auth/login` `{username,password}` | all | `{token, user:{username, role, display_name}}` |
| `GET /api/me` | all | current user |
| `GET /api/overview` | all | counts, last generation, last analysis, decision mix, source health. The bank counts and the source health are cached 60 s per Exasol user and cleared after a data generation |
| `POST /api/admin/generate` `{seed?:int, mode?:"replace"\|"append", companies?:100..5000}` | admin | `replace` clears everything and generates new data. `append` adds N new companies to the existing data. Both return `{job_id}` |
| `GET /api/jobs/{job_id}` | all | `{job_id, kind, status:"running"|"done"|"failed", progress:0..100, steps:[{name,status,detail}], started_at, finished_at, error}` |
| `GET /api/admin/sources` | admin, datasci | one entry per source, `{source, label, kind:"bank"|"api"|"exasol", status:"up"|"down", tables:[{name, rows}], latency_ms}` |
| `GET /api/admin/audit?limit=` | admin | who viewed or changed what |
| `GET /api/admin/purge-log` | admin | purge evidence |
| `GET /api/companies?q=&stage=&decision=&page=&size=` | all (an RM sees only companies assigned to her, filtered by Exasol) | list rows `{cif_id, legal_name, industry, city, stage, partners, rm_id, decision, rank_no, offer_amount}` |
| `GET /api/companies/{cif_id}/tree` | all (scope by role) | tree of nodes `{id, label, sublabel, source, kind, children:[...]}` |
| `GET /api/nodes/{node_id}` | all (scope by role) | records behind one tree node `{node_id, title, source, columns:[...], rows:[[...]], meta:{}}` |
| `POST /api/analysis/run` | datasci | runs `CREDORA.RUN_ANALYSIS()` in Exasol. The new run is a **draft** until published. It returns `{job_id}` |
| `POST /api/runs/{run_id}/publish` `{note?}` | datasci | hands a finished draft run to loan operations. It writes `CREDORA.RUN_PUBLISH` as `CREDORA_SVC`, exports the run's offers to the CRM and audits `RUN_PUBLISH`. The run becomes the official one |
| `GET /api/runs` | admin, datasci, loanops | analysis runs with timings, counts and publish state (loanops sees published runs only) |
| `GET /api/decisions?decision=&grade=&assigned=yes\|no&page=` | admin, datasci, loanops | decision rows of the latest published run, with the assigned RM |
| `GET /api/top50?run_id=` | admin, datasci, loanops | top 50 from `PREFERRING`, with the assigned RM. `run_id` picks another run (loanops can pick published runs only, datasci and admin also drafts) |
| `GET /api/rms` | admin, datasci, loanops | the 12 relationship managers of the customer master (`cif.rm`) with how many companies each works |
| `GET /api/assignments` | all (an RM sees her own, through `V_RM_ASSIGNMENT`) | `[{cif_id, rm_id, assigned_by, assigned_at}]` from `CREDORA.RM_ASSIGNMENT` |
| `POST /api/assignments` `{cif_ids:[...], rm_id}` | loanops | assigns (or moves) companies of the published run to a relationship manager, single or bulk (up to 500). The rows are written to `CREDORA.RM_ASSIGNMENT` as `CREDORA_SVC` with the manager's Exasol user, and the call audits `ASSIGN_RM` |
| `GET /api/loan-status?rm_id=&status=` | all (an RM sees her own companies) | Loan status tracker. It lists every assigned company with its RM, current status, last update and history |
| `POST /api/loan-status/{cif_id}` `{status, note}` | rm | logs CONTACTED, NEGOTIATING, LOAN_TAKEN, IN_PROGRESS, DISBURSED or NOT_INTERESTED for an assigned company (note required) in `CREDORA.LOAN_STATUS_LOG` and audits `LOAN_STATUS`. The status follows the state machine below |
| `GET /api/companies/{cif_id}/report` | admin, datasci, loanops, rm | Exasol report with decision, grade, pd, rank, offer, limit, reasons (feature attribution), features, steps (each with the SQL that ran) and sources used |
| `POST /api/ml/train` | datasci | trains a new champion (`v<n>`, gradient-boosted trees) and challenger (`v<n>-lr`, logistic regression scorecard) on the same hold-out and shadow-scores the current run with the challenger. Both are registered inactive. The active model stays active until the admin approves an activation request, and only the very first model is activated at once. It returns `{job_id}` |
| `GET /api/ml/models` | datasci, admin | versions with AUC, Gini, feature importance (signed coefficients for the scorecard), the model file's SHA-256, active flag, champion/challenger role |
| `GET /api/ml/compare` | datasci, admin | champion vs challenger, with AUC, Gini, top features or coefficients, and on the current run the grades and decisions the challenger would change |
| `GET /api/ml/activation-requests` | admin (all), datasci (own) | risk-model activation requests from `crm.model_activation_request` |
| `POST /api/ml/activation-requests` `{version, note}` | datasci | requests activation of an inactive model (note required, one pending request per model) and audits `MODEL_ACTIVATION_REQUEST` |
| `POST /api/ml/activation-requests/{id}/approve` / `reject` `{note}` | admin | maker-checker. Approve switches `CREDORA.MODEL_REGISTRY.IS_ACTIVE` as `CREDORA_SVC`. Nobody decides their own request, and decided requests are read-only. The call is blocked when another model became active since the request. Decisions are audited as `MODEL_ACTIVATION_APPROVE` / `MODEL_ACTIVATION_REJECT` |
| `GET /api/approvals/pending` | admin | `{policy, models}`, the pending counts for the Approvals badge |
| `POST /api/whatif` `{hurdle_pct?, eblr_pct?, max_gst_share_pct?}` | datasci | counts of approve/refer/decline before and after |
| `GET /api/whatif/runs` / `POST /api/whatif/runs` `{hurdle_pct?, eblr_pct?, max_gst_share_pct?}` | datasci | saved what-if runs (`crm.whatif_run`) with levers, baseline and outcome. The What-if page exports them as `credora-whatif-runs-YYYYMMDD.csv` |
| `GET /api/policy/proposals` | admin (all), datasci (own) | policy proposals (`crm.policy_proposal`). Pending ones carry `baseline_changed` |
| `POST /api/policy/proposals` `{run_id, note}` | datasci | sends a saved what-if run to the admin as a PENDING proposal (lever diff, outcome vs the official run, note). Each run can have one pending proposal. The call audits `POLICY_PROPOSE` |
| `POST /api/policy/proposals/{id}/approve` / `reject` `{note}` | admin | Approve runs one job that writes the levers to `CREDORA.CONFIG` as `CREDORA_SVC`, runs the full official analysis, publishes it (by the system on the admin's behalf) and records `applied_run_id`. When `CONFIG` changed, the call is blocked with `Policy changed since this proposal; ask for a new what-if run`. Nobody decides their own proposal. Decisions are audited as `POLICY_APPROVE` / `POLICY_REJECT` |
| `GET /api/offers?stage=` | rm, loanops, admin | CRM pipeline |
| `POST /api/offers/{offer_id}/quote` `{amount, roi, tenure}` | rm | Exasol checks the terms and returns `{within_limit, raroc, emi, lgd_pct, reasons}` |
| `POST /api/offers/{offer_id}/propose` `{amount, roi, tenure, note}` | rm | records agreed terms. Above the limit the offer goes to ESCALATED |
| `POST /api/offers/{offer_id}/verify` / `sanction` / `reject` `{note}` | loanops | maker-checker |
| `GET /api/offers/{offer_id}/events` | rm, loanops, admin | negotiation trail |
| `GET /api/ai/status` | all | whether the AI features are on. The assistant needs an AI provider and at least one `EXA_*_AI_PASSWORD` |
| `POST /api/ai/ask` `{question}` | all | Ask Credora. After a topic check, Claude answers through the Exasol MCP server logged in as the caller's own AI session user (the role user with the `_AI` suffix). The response holds the answer, every tool call and the Exasol user |
| `POST /api/companies/{cif_id}/memo` | admin, datasci, loanops, rm | writes a credit memo for the company (inside Exasol by `CREDORA.CREDIT_MEMO` when possible) and stores it |
| `GET /api/companies/{cif_id}/memo` | admin, datasci, loanops, rm | the latest stored credit memo for the current run, or `404` |
| `GET /api/exasol/console?since=&scope=` | all (own statements, `scope=all` admin only) | Explain mode's Exasol console, listing the statements the backend ran in Exasol for this tab, with Exasol user, ms, rows, error |
| `GET /api/exasol/control-room` | all (each read as the caller's own Exasol user) | Explain mode's control room, covering schemas, virtual schemas, scripts, connections (names), model registry, grants, preprocessor, semantic model, latest run and sessions (admin) |

### Backend response shapes

The shapes follow `frontend/src/api/types.ts`. Where this document and `types.ts` differed, `types.ts` won. Reads for a signed-in person run as that role's Exasol user (`CREDORA_ADMIN`, `CREDORA_DATASCI`, `CREDORA_LOANOPS`, `CREDORA_RM`, and `CREDORA_RM002` for the second relationship manager), so Exasol enforces access. Ask Credora runs as the person's AI session user instead (`CREDORA_<ROLE>_AI`, see `POST /api/ai/ask`). A query Exasol refuses comes back as `403 {"detail":"Exasol denied access for your role: ...\n<the refused SQL>"}`, with the refused statement on a second line of `detail`, without its tag comment. Analysis, training, the CRM export, model activation and the purge run as `CREDORA_SVC`. Times are ISO 8601 in UTC (`...Z`). Errors are `{"detail": "..."}`.

**Sign-in.** `POST /api/auth/login` returns `{token, user:{username, role, display_name, rm_id?}}`. The token is an HS256 JWT signed with `APP_SECRET`, valid 12 hours. Send it as `Authorization: Bearer <token>`. Usernames are the role names. The `rm` login acts as one relationship manager, `APP_RM_ID` (default `RM001`), and sees only companies and offers whose `rm_id` matches.

**Current run.** Lists and reports use the newest analysis run that finished without a failed step and after the last data generation (`GET generator/last`). Until analysis runs on fresh data, reports return `404` and decision fields are `null`.

| Endpoint | Response |
|---|---|
| `GET /api/me` | `User` |
| `GET /api/overview` | `{counts:{companies, partners, applications, accounts}, last_generation:{seed, generated_at, job_id}\|null, last_analysis:{run_id, finished_at, duration_ms, model_version, published_by, published_at}\|null, decision_mix:{APPROVE, REFER, DECLINE}\|null, sources:[SourceHealth]}`. `last_analysis` is the latest published run. For an RM the counts and mix cover the companies assigned to her, read from `V_RM_COMPANY` and `V_RM_DECISIONS`, and `accounts` = their company current accounts. Source health is a system probe run as the service account. The bank counts and the source health are cached for 60 s per Exasol user and cleared after a data generation. |
| `GET /api/jobs/{id}` | `{job_id, kind:"generate"\|"analysis"\|"train", status, progress, steps:[{name, status, detail}], started_at, finished_at, error, ...}`. Analysis adds `run_id`, `counts`, `crm`. Training adds `version`, `auc`, `gini`, `challenger`, `challenger_auc`, `challenger_gini`. Generation adds `seed`, `mode`, `companies`, and `counts`/`added` once the generator reports them. Jobs live in the API process's memory. |
| `GET /api/admin/sources` | `[{source, label, kind, status, tables:[{name, rows}], latency_ms}]`. Bank tables are counted through `VS_CBS` / `VS_CIF` / `VS_LOS` (plus `crm.offer`, `crm.offer_event`), API counts come from each mock's `/status` and Exasol counts cover `CREDORA.*`. |
| `GET /api/admin/audit?limit=` | `[{at, username, role, action, target, detail}]` from `crm.audit_event` (LOGIN, VIEW_TREE, VIEW_NODE, VIEW_REPORT, RUN_ANALYSIS, RUN_PUBLISH, GENERATE, TRAIN_MODEL, MODEL_ACTIVATION_REQUEST, MODEL_ACTIVATION_APPROVE, MODEL_ACTIVATION_REJECT, WHAT_IF, WHAT_IF_RUN, POLICY_PROPOSE, POLICY_APPROVE, POLICY_REJECT, POLICY_APPLY, ASSIGN_RM, LOAN_STATUS, PROPOSE, VERIFY, SANCTION, REJECT, ASK_CREDORA, CREDIT_MEMO). A run the policy job publishes is audited as `RUN_PUBLISH` by `system`, with the approving admin in the detail. |
| `GET /api/admin/purge-log` | `[{purged_at, table_name, source, rows, sha256, run_id, purge_due}]` from `CREDORA.PURGE_LOG`. The log keeps no due time, so `purge_due` equals `purged_at`. The Exasol Scheduler, a container on the app host logged in as `CREDORA_SVC`, runs `CREDORA.PURGE_EXPIRED()` every 15 minutes, with its tasks and history in the Exasol tables `SCHED.SCHED_TASKS` and `SCHED.SCHED_HISTORY`. The script sorts the expiring rows by key, hashes chunks of 1,000 with `HASH_SHA256` of `LISTAGG` and logs the hash of the chunk hashes (one run's GST rows are above Exasol's 2,000,000-character `LISTAGG` limit), handles one table per transaction, and skips while an analysis logged a step in the last 3 minutes. The backend runs it too only when its fallback switch `PURGE_INTERVAL_MIN` is above `0` (default `0`, off). |
| `GET /api/admin/exasol-audit?exa_user=&app_user=&feature=&success=&hours=&limit=&internal=` | Admin only. `{items:[{session_id, stmt_id, started_at, exa_user, client, app_user, feature, consumer_group, command, sql, duration_s, cpu_pct, temp_ram_mib, rows, success, error}], read_as:"CREDORA_ADMIN", hours}` from Exasol's audit log, `EXA_DBA_AUDIT_SQL` joined with `EXA_DBA_AUDIT_SESSIONS`, read as `CREDORA_ADMIN` (`SELECT ANY DICTIONARY`, granted to that user and not to role `R_ADMIN`). Secrets inside `IDENTIFIED BY '...'` are masked with `REGEXP_REPLACE` inside Exasol before the text leaves the database. It covers Credora's database users only (the role users, `CREDORA_RM002`, the `CREDORA_*_AI` session users, `CREDORA_SVC` and `CREDORA_MCP`), newest first. `app_user` and `feature` come from the statement's `/*credora:<app user>:<feature>*/` tag or the session's client name (`credora:<app user>:<feature>`, and the Exasol Scheduler's sessions are `app_user` `scheduler`). Automatic commits and the SQL preprocessor's own lookups are hidden unless `internal=true`. `hours` 1 to 720 (default 24), `limit` up to 1,000 (default 200), `success` `true`/`false`. |
| `GET /api/admin/exasol-audit/analysis?run_id=` | Admin only. `{run_id, call, statements:[... + step_no], commits}`, holding the latest (or the named) `EXECUTE SCRIPT CREDORA.RUN_ANALYSIS(...)` in the audit log and every statement the script ran in that session, numbered by the step whose `COMMIT` closes them. |
| `GET /api/admin/schedule` | Admin and data scientist. `{installed, tasks:[{task_id, enabled, schedule, sql, after, is_final, comment, last_status, last_started_at}], runs:[{task_id, graph_run_id, phase, status, scheduled_for, started_at, finished_at, seconds, error}], purge:{next_due, rows_waiting, purge_log_entries, rows_deleted, last_purged_at}}` from `SCHED.SCHED_TASKS`, `SCHED.SCHED_HISTORY` (last 60 runs, in UTC as the scheduler writes them), `CREDORA_STAGE` (the earliest `PURGE_AT` still waiting) and `CREDORA.PURGE_LOG`, read as the caller's role user. |
| `GET /api/admin/rls-proof` | Admin and data scientist. `[{exa_user, sql, rows, error, ms}]`, four statements Exasol runs as separate users, each on a connection of its own that is closed right after. `SELECT COUNT(*) N FROM CREDORA.V_RM_DECISIONS` as `CREDORA_RM`, as the AI session user `CREDORA_RM_AI` (the same count, because the row filter strips the `_AI` suffix from `CURRENT_USER`) and as the second manager `CREDORA_RM002` (a different book), then `SELECT COUNT(*) N FROM CREDORA.DECISIONS` as `CREDORA_RM`, which Exasol refuses with "insufficient privileges" because role `R_RM` holds no grant on the table under the view. `rows` is the count or `null`. `error` is Exasol's message, `"not configured"` when that user has no password on this server, or `null`. The control room shows it as "Row-level security, proven by Exasol". |
| `GET /api/sources/pushdown` | Admin and data scientist. `{items:[{key, source, schema, step, title, query, explain_ms, pushdowns:[{id, tables, pushdown_sql, connection, driver, sql}]}]}`, the `EXPLAIN VIRTUAL` of the analysis's reads of the bank's databases (step 7's Oracle aggregation through `VS_CBS`, step 2's PostgreSQL and MySQL reads through `VS_LOS` and `VS_CIF`), run as the caller's role user and cached 10 minutes. `sql` is the statement the source database receives (from the `IMPORT ... STATEMENT` of the Oracle adapter or the `ADBC_SCAN` spec of adbc-vs-rs). |
| `GET /api/companies` | `{items:[CompanyRow], total, page, size}`. `stage` is `""` before analysis. For an RM the rows come from `CREDORA.V_RM_COMPANY` and `V_RM_DECISIONS`, so Exasol returns only the companies assigned to her Exasol user. `rm_id` is the assigned manager. |
| `GET /api/companies/{cif}/tree` | `TreeNode`. Node ids are `C…`, `C…:account`, `C…:txns`, `C…:application`, `C…:gst`, `C…:gst:<year>`, `C…:cibil`, `C…:partner:<id>`, `…:cibil`, `…:sapphire`, `…:aa:<aa_account_id>` and `C…:report`. API nodes appear only for admin and datasci. RMs get the company, application and report nodes of an assigned company, read from `CREDORA.V_RM_COMPANY` with full PAN and GSTIN (tagged `exasol`). Any other company returns `403`. |
| `GET /api/nodes/{id}` | `{node_id, title, source, columns, rows, meta}`. `meta` has `table`, `database`, `via` (the virtual schema object) for bank records and `endpoint` for API records. |
| `GET /api/runs` | `[Run + published, published_by, published_at, publish_note]`, newest first, failed runs last. `started_by` comes from the audit log (`system` if unknown). A finished run with `published:false` is a draft. The current (official) run everywhere else is the newest finished **published** run (`CREDORA.RUN_PUBLISH`), the same run `CREDORA.V_LATEST_RUN` returns. |
| `GET /api/loan-status` | `[{cif_id, legal_name, rm_id, rm_name, assigned_by, assigned_at, decision, rank_no, offer_amount, status, note, updated_at, updated_by, history:[{event_id, cif_id, rm_id, status, note, actor, at}]}]`, last update first. `status` is `ASSIGNED` until the RM logs one. An RM's rows come from `V_RM_ASSIGNMENT`, `V_RM_DECISIONS` and `V_RM_LOAN_STATUS`. |
| `POST /api/assignments` | `{rm_id, assigned, moved, unchanged}`. `404` for a company not in the published run, `409` when nothing is published, `422` for an unknown manager. The Exasol user is `CREDORA_RM` for the demo manager (`APP_RM_ID`, RM001) and `CREDORA_<rm_id>` for the others. |
| `POST /api/loan-status/{cif}` | the new history row. `403` if the company is not assigned to the RM, `409` once DISBURSED, for an unchanged status, for a step the state machine does not allow, or for Loan taken onwards without agreed or sanctioned terms. `422` without a note. |

### Loan status state machine

The relationship manager moves a company one step at a time. Contacted leads to Negotiating, then Loan taken, then In progress, then Disbursed. Not interested is open from every status except Disbursed, and Contacted reopens a company marked Not interested. Disbursed is final. The rules live in `app/rmbook.py` (`NEXT`, `offer_block`).

Loan taken, In progress and Disbursed need terms the bank has agreed to. The company's newest CRM offer must be NEGOTIATING (terms agreed within the negotiation limits), VERIFIED after an in-limit proposal, or SANCTIONED by loan operations. An offer that was escalated must be verified and sanctioned first. Otherwise the request gets `409` with the reason.

The offer and the status stay in step. A proposal moves the status from Assigned or Contacted to Negotiating. Once the status is Loan taken or later, the RM cannot propose new terms and loan operations cannot reject the offer (`409`). Each `GET /api/loan-status` row also carries `offer_id`, `offer_stage`, `offer_block` (why Loan taken is not open yet, or null) and `next_statuses`, which the My companies screen uses to enable its options.

More endpoints and their responses.

| Endpoint | Response |
|---|---|
| `GET /api/decisions` | `{items:[DecisionRow + hard_fails], total, page, size, run_id}`, ordered by rank. `raroc` is `RAROC_OFFER`. |
| `GET /api/top50` | `[Top50Row + skyline_layer, rm_id, assigned_rm_id]`. `stage` is the CRM stage. `rm_id` is the customer master's owner and `assigned_rm_id` is who works the company now. |
| `GET /api/companies/{cif}/report` | `Report` plus `hard_fails:[...]`, `raroc_floor` and `pricing`, which is `{industry, cash_margin_pct, cash_12m, collateral_type, collateral_value, lgd_pct, existing_exposure, exposure_room}` from the pricing inputs stored with the decision ([PRICING.md](PRICING.md)), or `null` for a run made before they were stored. `reasons[].contribution` is the feature's change to PD in **percentage points** (from `SCORES.CONTRIBUTIONS`, PD with the feature against PD at the portfolio median). A positive value raises risk, and the report lists up to 4 drivers each way. `steps` are the 13 `RUN_ANALYSIS` steps with that run's `RUN_LOG` duration and the real script text (step 10 is the anomaly flag, step 13 the shadow challenger). `anomaly` is `{score, flagged, reasons:[...]}` from `CREDORA.ANOMALY`, or `null` for runs without that step. A flagged company that would be approved is referred and its `hard_fails` carry `Anomaly: ...`. An RM gets the full report of an assigned company (features and sources), read through `V_RM_DECISIONS`, `V_RM_SCORES`, `V_RM_FEATURES` and `V_RM_COMPANY`. Any other company returns `403`. `anomaly` is `null` for RMs because `CREDORA_RM` may not read `CREDORA.ANOMALY`. An RM sees the flag only as that reason. |
| `GET /api/ml/models` | `[Model + default_rate, model_path, model_sha256]`, with `model_sha256` the SHA-256 of the pickle in BucketFS that `PD_SCORE` checks before unpickling, and `trained_by` from the audit log (a `v<n>-lr` scorecard takes its champion's). `role` is `"champion"` (active), `"challenger"` (the newest inactive model of the other algorithm, the one `CREDORA.SCORE_CHALLENGER` scores) or `null`. `kind` is `"coefficient"` for the scorecard, whose `feature_importance` values are signed log-odds per standard deviation ordered by size, else `"importance"`. |
| `GET /api/ml/compare` | `ModelComparison`, which is `{run_id, active_version, champion, challenger, same_holdout, scored, companies, grades_changed, decisions_changed, champion_mean_pd, challenger_mean_pd, transitions:[{from, to, n}], changed:[{cif_id, legal_name, from, to, champion_pd, challenger_pd, champion_grade, challenger_grade}]}`. `champion` and `challenger` are `{version, algorithm, active, auc, gini, kind, top:[{feature, importance}]}` (top 5). The run figures come from `CREDORA.CHALLENGER_SCORES` joined with `SCORES` and `DECISIONS` of the current run. `changed` is the 8 companies with the largest PD difference among those whose decision would change. `scored` is false until a run or a training has shadow-scored the current run. |
| `GET /api/ml/activation-requests` | `[{request_id, created_at, created_by, model_version, current_version, metrics:{candidate, current}, note, status, decided_by, decided_at, decision_note, baseline_changed?}]`, pending first. There is no direct activation endpoint. |
| `POST /api/whatif` | `{params, baseline, before, after, run_id}`. One Exasol query re-runs the decision step of `RUN_ANALYSIS` over the current run's stored features and scores with the overridden `CONFIG` values, and nothing is written. |
| `GET /api/offers?stage=A,B&include_declined=` | `[Offer]` (`crm.offer` with `legal_name`, `rm_id`), by rank. Offers whose Exasol decision was DECLINE are left out unless `include_declined=true`. |
| `POST /api/offers/{id}/quote` | `{within_limit, raroc, emi, lgd_pct, reasons}` computed in Exasol from `CREDORA.CONFIG` and the run's decision row. EMI is amortising for TL and interest only for WC. Within limit means amount ≤ max, ROI ≥ floor, tenure ≤ max and RAROC ≥ hurdle. RAROC uses the decision's LGD after collateral (`DECISIONS.LGD_PCT`, returned as `lgd_pct`), or the policy LGD for an older run. |
| `POST /api/offers/{id}/propose` | `Offer`. Within limit it goes to NEGOTIATING, otherwise to ESCALATED with a `system` ESCALATE event. Only from OFFERED, NEGOTIATING or ESCALATED. |
| `POST /api/offers/{id}/verify` / `sanction` / `reject` | `Offer`. A note is required. Verify moves NEGOTIATING or ESCALATED with proposed terms to VERIFIED, sanction moves VERIFIED to SANCTIONED, and reject moves any open stage to DECLINED. |
| `GET /api/offers/{id}/events` | `[OfferEvent]`, oldest first |
| `GET /api/ai/status` | `{enabled, provider, model, assistant}`. `enabled` is true when `AI_PROVIDER` is `anthropic` (with `ANTHROPIC_API_KEY` and `AI_MODEL`) or `bedrock` (with `BEDROCK_MODEL_ID`, or `AI_MODEL`, from which the Bedrock id `anthropic.<AI_MODEL>` is formed). `model` is the id sent to the provider. With `bedrock` the backend talks to Claude in Amazon Bedrock through the Anthropic SDK's Bedrock client (`AnthropicBedrock`, package extra `anthropic[bedrock]`), signing with the AWS credentials of the app host (the EC2 instance role) in `AWS_REGION`, so no API key is stored. `assistant` also needs at least one AI session user password (`EXA_ADMIN_AI_PASSWORD`, `EXA_DATASCI_AI_PASSWORD`, `EXA_LOANOPS_AI_PASSWORD` or `EXA_RM_AI_PASSWORD`), not `EXA_MCP_PASSWORD`. The deployed site runs `AI_PROVIDER=anthropic` with `AI_MODEL=claude-sonnet-5-5`. |
| `POST /api/ai/ask` | `{answer, steps:[{tool, input, result_preview, is_error}], model, run_id, exasol_user}`, or `{answer, steps:[], model, run_id:null, off_topic:true}` for a refused question. **Topic check.** Before any tool use, one short classification call (`max_tokens` 5, answer `IN` or `OUT`) decides whether the question is about Credora's analysis. An `OUT` question (general knowledge, poems, recipes, "ignore your rules") gets a fixed refusal and never reaches Exasol. If the check itself fails, the main prompt's scope rule still applies. **Exasol login.** The backend starts the official Exasol MCP server (`exasol-mcp-server` 2.3.0) over stdio, logged in as the caller's own AI session user, `CREDORA_ADMIN_AI`, `CREDORA_DATASCI_AI`, `CREDORA_LOANOPS_AI` or `CREDORA_RM_AI`. Each holds the same role as the person's own user, so the admin's and the data scientist's AI read results, `CREDORA_SEM.PORTFOLIO`, `VS_CBS`, `VS_CIF`, `VS_LOS` and `CREDORA_STAGE`, loan operations' AI the same without `CREDORA_STAGE`, and the relationship manager's AI only the row-filtered `V_RM_*` views, `V_LATEST_*` and `CREDORA_SEM.PORTFOLIO` (all filtered to her assigned companies by Exasol, because the row filter strips the `_AI` suffix from `CURRENT_USER`), `CONFIG` and `RUN_LOG`. The admin's AI user cannot read the audit log or the system tables, because `SELECT ANY DICTIONARY` is on the user `CREDORA_ADMIN` only. The AI users sit in consumer group `CREDORA_AI`, where Exasol applies the 60 s statement limit and the 2 GiB temporary memory limit, with no per-session SQL. `exasol_user` names that user. A signed-in role whose AI user has no configured password gets `503 {"detail":"Ask Credora is not set up for this role."}`. `CREDORA_MCP` (role `R_MCP`, read-only results) is only for AI clients outside the app. The server runs with read queries and table summaries only. It has no writes, no BucketFS writes, no profiling and no preprocessor tools, and Exasol grants decide what each query may read. Its tools are passed to Claude, which may make up to 8 tool calls. `steps` lists them in order, with the SQL in `input.query` for `execute_exasol_query` and the first 1,200 characters of each result. `run_id` is the current run, given to Claude so it filters to it. The endpoint returns `503` when AI is off or the MCP server cannot start, `502` when the AI provider fails and `422` for an empty question or one over 1,000 characters. Each question is audited as `ASK_CREDORA`. |
| `POST /api/companies/{cif}/memo` | `{memo, model, engine:"exasol-udf"\|"backend", created_at, run_id}`. The facts are built from the same data as the report (decision, policy rules failed, grade, PD, rank, indicated need vs pre-approved offer vs negotiation limit, RAROC, top reasons, key features, GST stage), read as the caller's role. With `AI_PROVIDER=anthropic` and the Exasol `CONNECTION AI_LLM` present, the memo is written inside Exasol by `SELECT CREDORA.CREDIT_MEMO('AI_LLM', <model>, <cif>, <facts JSON>)` as `CREDORA_SVC` (`engine:"exasol-udf"`). Otherwise the backend calls the model (`engine:"backend"`, e.g. Bedrock). The UDF calls `api.anthropic.com` with the key held in `CONNECTION AI_LLM`, so that engine is Anthropic only, and `AI_PROVIDER=bedrock` always uses the backend engine. The memo is stored in `CREDORA.MEMOS` as `CREDORA_SVC`, and `MODEL` holds `<model>\|<engine>`. The endpoint returns `503` when AI is off. |
| `GET /api/companies/{cif}/memo` | the latest stored memo for the company in the current run, same shape, or `404`. RMs only for companies assigned to them. |
| `GET /api/exasol/console?since=&scope=session\|user\|all` | All roles (Explain mode). `{entries:[{id, seq, at, kind:"sql"\|"step"\|"mcp"\|"event", exa_user, username, role, session, label, sql, text, ms, rows, error, repeat, via, tool, objects}], last, scope, exasol_user}`, the statements the backend ran in Exasol for the caller, oldest first, from a ring buffer of the latest 200 per signed-in person kept in the API's memory ([backend/app/console.py](../backend/app/console.py)). Every `exa.query` and job statement is recorded with the Exasol user it ran as, its time, its row count (or error), the screen or action (`label`, e.g. "Exasol report") and the browser tab (`session`, from the `X-Credora-Session` header the web app sends). `kind:"step"` entries are `RUN_ANALYSIS` steps as each one commits and the training's model registrations. `"event"` entries say what changed (a publish, a `MODEL_REGISTRY.IS_ACTIVE` switch, a data generation). `"mcp"` entries are Ask Credora's tool calls with their SQL and `via` "Claude → exasol-mcp-server (EC2 app host) → Exasol as CREDORA_<ROLE>". A repeated statement within 15 s (a poll) is one entry with a `repeat` count. Its `seq` moves on, so `since=<last>` returns only what is new or updated. `scope=session` (default) is this tab only, `user` every tab of the login, `all` (admin only, else `403`) every person's entries plus the system's (start-up, purge fallback). Configured passwords, keys and tokens are replaced by `***`, as are `IDENTIFIED BY`, connection addresses and users in `CREATE CONNECTION`, and string literals that look like credentials. The web app polls every 1.5 s while the console drawer is open and every 15 s while it is closed. |
| `GET /api/exasol/control-room?fresh=` | All roles (Explain mode). A map of the database read from Exasol's system tables **as the caller's role user**, so each role sees what its grants allow. Results are cached 8 s per role (`fresh=true` reads again). Each section is `{ok:true, data, ms}` or `{ok:false, denied, error, ms}`, because a refusal by Exasol is part of the answer. The sections are `system` (version from `EXA_METADATA`, `current_user`, `session_id`, nodes, vCPU and DB RAM from `EXA_SYSTEM_EVENTS`, `instance_type` from `EXASOL_INSTANCE`, deployment), `schemas` (`EXA_ALL_SCHEMAS` with object counts per type from `EXA_ALL_OBJECTS`), `virtual_schemas` (`EXA_ALL_VIRTUAL_SCHEMAS` with adapter, last refresh and by whom, ADBC driver and version from the adapter notes, the source database and connection), `scripts` (`EXA_ALL_SCRIPTS` of `CREDORA`, `ADAPTER`, `ADBC_VS`, `PREPROC_RT`, `SCHED` with type, language, input `SET`/`SCALAR` and result, plus counts per schema), `connections` (`EXA_ALL_CONNECTIONS` names and creation time only, never addresses or credentials), `models` (`CREDORA.MODEL_REGISTRY` with each pickle's BucketFS path, refused for `CREDORA_RM`), `security` (the admin gets `EXA_DBA_ROLE_PRIVS`, `EXA_DBA_SYS_PRIVS`, `EXA_DBA_OBJ_PRIVS` and `EXA_DBA_USERS` for the `R_*` roles, and other roles get their own `EXA_USER_ROLE_PRIVS`, `EXA_ROLE_SYS_PRIVS`, `EXA_ROLE_OBJ_PRIVS`), `preprocessor` (`SQL_PREPROCESSOR_SCRIPT` system and session value, and the `SCRIPT_LANGUAGES` aliases), `semantic` (`SEMANTIC_CATALOG.MODELS` and the certified metrics of model `credora`), `run_log` (the latest run's `RUN_LOG` steps), and for the admin only `sessions` (`EXA_DBA_SESSIONS` with user, client, status, consumer group, duration). The response also carries `role`, `exasol_user`, `read_at`, `took_ms`, `cached`. Statements run one after another on one pooled session, because Exasol Personal allows 20 parallel connections in all. |

**CRM export.** After each successful analysis run, offers are upserted by `app_id`. Rows at OFFERED or DECLINED take the new run's terms (APPROVE and REFER become OFFERED, DECLINE becomes DECLINED) and keep their `offer_id`. Rows at NEGOTIATING, ESCALATED, VERIFIED or SANCTIONED keep their state. If the CRM is empty when offers are first listed, the current run is exported then. The table `crm.offer` has a unique index on (`run_id`, `app_id`), so two overlapping exports of the same run end with a `409` for the second one, which the first visit's backfill ignores. The backend adds `legal_name` and `rm_id` columns to `crm.offer` and creates `crm.audit_event`.

**Backend environment.** The runtime secret keys (`APP_SECRET`, `APP_*_PASSWORD`, `EXASOL_HOST`, `EXASOL_PORT`, `EXA_SVC_PASSWORD`, `EXA_ADMIN_PASSWORD`, `EXA_DATASCI_PASSWORD`, `EXA_LOANOPS_PASSWORD`, `EXA_RM_PASSWORD`, `EXA_RM002_PASSWORD`, `EXA_ADMIN_AI_PASSWORD`, `EXA_DATASCI_AI_PASSWORD`, `EXA_LOANOPS_AI_PASSWORD`, `EXA_RM_AI_PASSWORD`, `EXA_MCP_PASSWORD`, `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `MOCK_API_TOKEN`, `AI_PROVIDER`, `AI_MODEL`, `ANTHROPIC_API_KEY`), plus `GENERATOR_URL`, `MOCK_CIBIL_URL`, `MOCK_GSTN_URL`, `MOCK_AA_URL` from compose. The optional variables, with defaults in parentheses, are `APP_RM_ID` (RM001), `PG_CRM_DB` (crm), `PG_SSLMODE` (require), `EXA_POOL_SIZE` (3), `TOKEN_HOURS` (12), `PURGE_INTERVAL_MIN` (0), `EXASOL_FINGERPRINT`, `AWS_REGION`, `BEDROCK_MODEL_ID` and `MCP_SERVER_CMD`. `PURGE_INTERVAL_MIN` makes the backend's purge a fallback switch, off by default because the Exasol Scheduler runs the purge. `EXASOL_FINGERPRINT` is Exasol's TLS certificate fingerprint. When it is set, the backend and the MCP server pin it with a `host/<fingerprint>:port` DSN, and `deploy/credora.py ship` writes it from the launcher's `connection-instructions.txt`. `AWS_REGION` and `BEDROCK_MODEL_ID` are for `AI_PROVIDER=bedrock`, whose AWS credentials come from the app host's instance role rather than from the environment file. `MCP_SERVER_CMD` is the command that starts the Exasol MCP server. By default it is the image's `/opt/exasol-mcp/bin/python -I app/mcp_session.py`, which starts `exasol-mcp-server` 2.3.0 with the client name `credora:<app user>:ask-credora` on every connection it opens. The AI's limits come from consumer group `CREDORA_AI`, not from session settings. The `EXA_*_AI_PASSWORD` keys belong to the AI session users, and `EXA_MCP_PASSWORD` to `CREDORA_MCP`, the read-only user for AI clients outside the app. Failing that, it uses `exasol-mcp-server` on `PATH`, then `uvx exasol-mcp-server@2.3.0`.

**Session tags.** Every backend session's client name is `credora:<app login>:web` (pooled screens) or `credora:<app login>:<job>` (analysis, training, generation, publish jobs), and every statement from `exa.query` starts with `/*credora:<app login>:<screen>*/`, so Exasol's audit log names the person and screen behind each statement.

### Site view counters

| Method and path | Auth | What it does |
|---|---|---|
| `GET /api/views` | none | Returns `{"docs": n, "ppt": n, "video": n}` |
| `POST /api/views/{site}` | none | Adds one view to `docs`, `ppt` or `video` and returns the counts. Any other site gives `404` |

The docs, presentation and video sites call `POST` once per browser per day, through their own domain. The CRM table `site_view` keeps one number per site. No IP address, browser or time is stored.
