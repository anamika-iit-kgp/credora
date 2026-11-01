# Credora data model

All data is synthetic, created by the mock data generator (`mocks/generator`). Sapphire Bank's own data lives in three RDS database servers (Oracle, MySQL, PostgreSQL). 3rd party data lives behind three mock 3rd party APIs (CIBIL, GSTN, Account Aggregator), each with its own database. Exasol reads the bank databases through virtual schemas, and its UDFs fetch 3rd party data on demand via API.

Identifiers are stable strings so they can be joined across systems.

| ID | Format | Example |
|---|---|---|
| Company CIF | `C` + 6 digits | `C000042` |
| Partner ID | `P` + 7 digits | `P0000123` |
| RM ID | `RM` + 3 digits | `RM007` |
| Application ID | `A` + 7 digits | `A0000042` |
| Sapphire account number | `5011` + 10 digits | `50110000004213` |
| PAN | 5 letters, 4 digits, 1 letter. The 4th letter is `C` for company, `F` for firm, `P` for person | `AAACS1234K` |
| GSTIN | 2-digit state code + PAN + `1Z` + check char | `27AAACS1234K1Z5` |

## 1. Oracle, core banking (`CBS` schema)

Sapphire Bank accounts and transactions.

```sql
CBS.ACCOUNT (
  ACCOUNT_NO        VARCHAR2(14) PRIMARY KEY,
  OWNER_TYPE        VARCHAR2(8)  NOT NULL,   -- 'COMPANY' | 'PARTNER'
  OWNER_ID          VARCHAR2(12) NOT NULL,   -- CIF id (Cxxxxxx) or partner id (Pxxxxxxx)
  ACCT_TYPE         VARCHAR2(4)  NOT NULL,   -- 'CA' current, 'SA' savings, 'OD' overdraft
  BRANCH            VARCHAR2(40),
  OPENED_ON         DATE NOT NULL,
  STATUS            VARCHAR2(8)  NOT NULL,   -- 'ACTIVE' | 'DORMANT' | 'CLOSED'
  OD_LIMIT          NUMBER(18,2) DEFAULT 0
)

CBS.TXN (
  TXN_ID            NUMBER(12)   PRIMARY KEY,
  ACCOUNT_NO        VARCHAR2(14) NOT NULL,
  TXN_DATE          DATE         NOT NULL,
  DR_CR             CHAR(1)      NOT NULL,   -- 'D' | 'C'
  AMOUNT            NUMBER(18,2) NOT NULL,
  CHANNEL           VARCHAR2(6)  NOT NULL,   -- NEFT RTGS IMPS UPI CHQ CASH
  COUNTERPARTY      VARCHAR2(80),
  NARRATION         VARCHAR2(120),
  BALANCE_AFTER     NUMBER(18,2) NOT NULL,
  BOUNCED           CHAR(1) DEFAULT 'N' NOT NULL  -- 'Y' for a returned cheque / failed debit
)
```

Every company has one `CA` account with 12–24 months of transactions. About 30% of partners hold an `SA` account at Sapphire Bank.

## 2. MySQL, customer master (`cif` database)

```sql
cif.rm (
  rm_id        VARCHAR(6) PRIMARY KEY,
  name         VARCHAR(60) NOT NULL,
  branch       VARCHAR(40) NOT NULL
)

cif.company (
  cif_id             VARCHAR(8)  PRIMARY KEY,
  legal_name         VARCHAR(120) NOT NULL,
  constitution       VARCHAR(30) NOT NULL,  -- 'Private Limited' | 'LLP' | 'Partnership' | 'Public Limited'
  pan                CHAR(10)    NOT NULL,
  gstin              CHAR(15)    NOT NULL,
  incorporated_on    DATE        NOT NULL,
  industry           VARCHAR(40) NOT NULL,
  city               VARCHAR(40) NOT NULL,
  state              VARCHAR(30) NOT NULL,
  rm_id              VARCHAR(6)  NOT NULL,
  kyc_status         VARCHAR(10) NOT NULL,  -- 'VERIFIED' | 'EXPIRED' | 'PENDING'
  kyc_expiry         DATE        NOT NULL,
  customer_since     DATE        NOT NULL
)

cif.partner (
  partner_id         VARCHAR(8)  PRIMARY KEY,
  cif_id             VARCHAR(8)  NOT NULL,  -- the company
  name               VARCHAR(80) NOT NULL,
  pan                CHAR(10)    NOT NULL,
  dob                DATE        NOT NULL,
  gender             CHAR(1)     NOT NULL,
  role               VARCHAR(20) NOT NULL,  -- 'Director' | 'Partner' | 'Promoter'
  share_pct          DECIMAL(5,2) NOT NULL,
  city               VARCHAR(40) NOT NULL,
  sapphire_customer  TINYINT(1)  NOT NULL   -- 1 if the partner banks with Sapphire
)
```

Each company has 2–5 partners. Their `share_pct` adds up to 100.

## 3. PostgreSQL, loan origination (`los` database) and CRM (`crm` database)

Two databases on the bank PostgreSQL server, tables in the `public` schema of each (the Exasol PostgreSQL virtual schema adapter exposes one schema of one database). The master user owns both and the backend writes `crm` with it. Role `credora_ro` has `SELECT` on all four tables. The DDL is in `db/postgres_los.sql` and `db/postgres_crm.sql`. A unique index on `offer (run_id, app_id)` keeps one offer per company per run.

```sql
-- database los
application (
  app_id              VARCHAR(8) PRIMARY KEY,
  cif_id              VARCHAR(8) NOT NULL,
  applied_on          DATE NOT NULL,
  product             VARCHAR(4) NOT NULL,      -- 'WC' working capital | 'TL' term loan
  amount_requested    NUMERIC(18,2) NOT NULL,   -- rupees
  tenure_requested    INTEGER NOT NULL,         -- months
  purpose             VARCHAR(80) NOT NULL,
  collateral_type     VARCHAR(30) NOT NULL,     -- 'Property' | 'Plant & machinery' | 'Receivables' | 'None'
  collateral_value    NUMERIC(18,2) NOT NULL,
  status              VARCHAR(12) NOT NULL      -- 'NEW' | 'ANALYSED'
)

-- Past loans with outcomes: training data for the risk model.
-- Features are the snapshot the bank stored when the loan was sanctioned.
past_loan (
  loan_id             VARCHAR(10) PRIMARY KEY,
  sanctioned_on       DATE NOT NULL,
  product             VARCHAR(4) NOT NULL,
  amount              NUMERIC(18,2) NOT NULL,
  gst_years           NUMERIC(4,1) NOT NULL,
  gst_turnover_12m    NUMERIC(18,2) NOT NULL,
  gst_late_filings_12m INTEGER NOT NULL,
  gst_bank_gap_pct    NUMERIC(7,2) NOT NULL,    -- |GST turnover - bank credits| / GST turnover * 100
  avg_balance_12m     NUMERIC(18,2) NOT NULL,
  inflow_volatility   NUMERIC(7,4) NOT NULL,    -- stddev / mean of monthly credits
  bounce_ratio        NUMERIC(7,4) NOT NULL,    -- bounced / debit count
  cmr_rank            INTEGER NOT NULL,         -- 1 best .. 10 worst
  partner_min_score   INTEGER NOT NULL,
  partner_avg_score   NUMERIC(6,1) NOT NULL,
  partner_overdue_amt NUMERIC(18,2) NOT NULL,
  partner_other_bank_bal NUMERIC(18,2) NOT NULL,
  dscr                NUMERIC(7,3) NOT NULL,
  defaulted           BOOLEAN NOT NULL
)

-- database crm
offer (
  offer_id            SERIAL PRIMARY KEY,
  run_id              VARCHAR(20) NOT NULL,
  app_id              VARCHAR(8) NOT NULL,
  cif_id              VARCHAR(8) NOT NULL,
  decision            VARCHAR(8) NOT NULL,      -- 'APPROVE' | 'REFER' | 'DECLINE'
  grade               VARCHAR(3),
  pd                  NUMERIC(7,5),
  rank_no             INTEGER,
  offer_amount        NUMERIC(18,2),
  offer_roi           NUMERIC(6,3),
  offer_tenure        INTEGER,
  floor_roi           NUMERIC(6,3),
  max_amount          NUMERIC(18,2),
  max_tenure          INTEGER,
  stage               VARCHAR(12) NOT NULL,     -- OFFERED NEGOTIATING ESCALATED VERIFIED SANCTIONED DECLINED
  agreed_amount       NUMERIC(18,2),
  agreed_roi          NUMERIC(6,3),
  agreed_tenure       INTEGER,
  updated_at          TIMESTAMP NOT NULL DEFAULT now()
)

offer_event (
  event_id            SERIAL PRIMARY KEY,
  offer_id            INTEGER NOT NULL,
  actor               VARCHAR(20) NOT NULL,     -- app user name
  action              VARCHAR(20) NOT NULL,     -- PROPOSE SUBMIT ESCALATE VERIFY SANCTION REJECT NOTE
  amount              NUMERIC(18,2),
  roi                 NUMERIC(6,3),
  tenure              INTEGER,
  note                VARCHAR(400),
  at                  TIMESTAMP NOT NULL DEFAULT now()
)

-- Maker-checker records (also created by the backend at startup, backend/app/crm.py)
whatif_run (run_id 'W0001', created_at, created_by, base_run_id, model_version, levers JSONB, baseline JSONB,
            before_mix JSONB, after_mix JSONB, before_amount, after_amount, ms)
policy_proposal (proposal_id SERIAL, created_at, created_by, run_id → whatif_run, levers JSONB [{key, old, new}],
                 outcome JSONB, note, status PENDING|APPROVED|REJECTED, decided_by, decided_at, decision_note,
                 applied_run_id)              -- at most one PENDING per run_id
model_activation_request (request_id SERIAL, created_at, created_by, model_version, current_version,
                          metrics JSONB, note, status PENDING|APPROVED|REJECTED, decided_by, decided_at,
                          decision_note)      -- at most one PENDING per model_version
audit_event (audit_id, at, username, role, action, target, detail)
```

## 4. Mock CIBIL (`cibil` database, served by `mocks/cibil`)

```sql
consumer_report (pan CHAR(10) PRIMARY KEY, name VARCHAR(80), dob DATE, score INT,  -- 300..900, or -1 = no history
                 report_date DATE, enquiries_6m INT, enquiries_12m INT)
consumer_account (id SERIAL PRIMARY KEY, pan CHAR(10), lender VARCHAR(40), acct_type VARCHAR(30),
                  -- 'Home Loan' 'Personal Loan' 'Credit Card' 'Auto Loan' 'Business Loan' 'Gold Loan'
                  opened_on DATE, sanctioned NUMERIC(18,2), balance NUMERIC(18,2), overdue NUMERIC(18,2),
                  status VARCHAR(12),   -- 'ACTIVE' 'CLOSED' 'WRITTEN_OFF' 'SETTLED'
                  dpd_36m VARCHAR(144)) -- 36 comma-separated monthly DPD values, newest first ('0,0,30,...')
commercial_report (pan CHAR(10) PRIMARY KEY, name VARCHAR(120), cmr_rank INT,  -- 1..10
                   report_date DATE, total_exposure NUMERIC(18,2), overdue NUMERIC(18,2),
                   suit_filed BOOLEAN, wilful_default BOOLEAN, facilities INT)
```

## 5. Mock GSTN (`gstn` database, served by `mocks/gstn`)

```sql
registration (gstin CHAR(15) PRIMARY KEY, legal_name VARCHAR(120), pan CHAR(10), state VARCHAR(30),
              registered_on DATE, status VARCHAR(10))   -- 'ACTIVE' | 'SUSPENDED'
filing (gstin CHAR(15), period CHAR(7),   -- 'YYYY-MM'
        gstr1_turnover NUMERIC(18,2), gstr3b_tax_paid NUMERIC(18,2),
        due_date DATE, filed_on DATE,      -- NULL = not filed
        PRIMARY KEY (gstin, period))
```

A return that was not filed has `filed_on`, `gstr1_turnover` and `gstr3b_tax_paid` all `NULL`. Only periods whose due date (the 20th of the next month) has passed are generated.

Each company has 2–10 years of monthly filings, chosen at random. 2–4 years is a **New** company, 5–7 **Mid-level**, 8–10 **Stable**.

## 6. Mock Account Aggregator (`aa` database, served by `mocks/aa`)

Accounts that partners (and some companies) hold at other banks.

```sql
fi_account (aa_account_id VARCHAR(16) PRIMARY KEY, owner_pan CHAR(10), owner_name VARCHAR(120),
            fip VARCHAR(40),          -- 'State Bank of India' 'HDFC Bank' 'ICICI Bank' 'Axis Bank' 'Kotak Mahindra Bank'
                                      -- 'Punjab National Bank' 'Bank of Baroda' 'Canara Bank' 'Union Bank of India' 'IndusInd Bank'
            acct_type VARCHAR(10),    -- 'SAVINGS' | 'CURRENT'
            masked_no VARCHAR(20), opened_on DATE, current_balance NUMERIC(18,2))
fi_txn (id BIGSERIAL PRIMARY KEY, aa_account_id VARCHAR(16), txn_date DATE, dr_cr CHAR(1), amount NUMERIC(18,2),
        narration VARCHAR(120), balance_after NUMERIC(18,2))
consent (consent_id VARCHAR(36) PRIMARY KEY, pan CHAR(10), purpose VARCHAR(60), status VARCHAR(10),
         created_at TIMESTAMP, expires_at TIMESTAMP)
```

Each partner has 1–3 accounts at other banks, with 12 months of transactions.

## 7. Hidden truth (`generator` output, database `truth` on mockdb)

```sql
truth (cif_id VARCHAR(8) PRIMARY KEY, true_pd NUMERIC(7,5), would_default BOOLEAN)
generation_job (job_id, seed, status, started_at, finished_at, seconds, counts JSONB, error)  -- backs GET /last
```

Every mockdb database (`cibil`, `gstn`, `aa`, `truth`) also has a one-row `meta (generated_at, seed, job_id)` table written at the end of each generation. The mocks' `/status` reads it. The DDL for all of mockdb is in `db/mockdb.sql`.

The generator gives every company a hidden risk level that drives all its data consistently. Risky companies file GST late, bounce more, show a bigger gap between GST turnover and bank credits, and have partners with lower scores. It saves the truth per company (`cif_id, true_pd, would_default`) to S3 and to the mock database `truth` table, so the admin scorecard can measure precision and recall. Exasol never reads it during a decision.

## 8. Feature definitions

`los.past_loan` stores these features as they stood at sanction. For each company analysed now, Exasol computes the same features from the raw data. The generator draws past-loan features from the same latent-risk process (and the same simulators) it uses for current companies, so a model trained on `past_loan` applies to the companies analysed now.

The definitions below are for one company analysed, that is one `los.application` row.

- `as_of` = `los.application.applied_on`.
- **12m window** = the 12 complete calendar months before the month of `as_of`, in SQL `TXN_DATE >= ADD_MONTHS(TRUNC(as_of,'MM'), -12) AND TXN_DATE < TRUNC(as_of,'MM')`. Calendar months are used because a partial month at either end would distort the monthly-credit volatility, and because GST periods are calendar months.
- **Last 12 periods** = the 12 most recent GST periods with `period < TO_CHAR(as_of,'YYYY-MM')`.
- **Company CA** = the company's `CBS.ACCOUNT` row with `OWNER_TYPE='COMPANY'` and `ACCT_TYPE='CA'`. Every current company has at least 13 months of CA transactions, so the 12m window is always full.
- **Partners** = the company's `cif.partner` rows. **Partner score** = `consumer_report.score`, with `-1` (no history) counted as **650**.

| Feature | Formula |
|---|---|
| `gst_years` | (months from `registration.registered_on` to `as_of`) / 12, where months = (year·12 + month of `as_of`) − (year·12 + month of `registered_on`), rounded to 1 decimal |
| `gst_turnover_12m` | `SUM(gstr1_turnover)` over the last 12 periods (unfiled periods are NULL and add nothing) |
| `gst_late_filings_12m` | count of the last 12 periods with `filed_on IS NULL OR filed_on > due_date`. NULL when the company has no GST returns on file, which gives REFER with the reason `No GST returns on file`, never DECLINE (the PD model fills the NULL from its training baseline) |
| `gst_bank_gap_pct` | `ABS(gst_turnover_12m − SUM(AMOUNT) of CA rows with DR_CR='C' in the 12m window) / gst_turnover_12m * 100` |
| `avg_balance_12m` | `AVG(BALANCE_AFTER)` over all CA rows in the 12m window (per transaction, not per day) |
| `inflow_volatility` | `STDDEV_POP(m) / AVG(m)` where `m` = the 12 monthly sums of CA credits (`DR_CR='C'`) in the 12m window. A month with no credits counts as 0 |
| `bounce_ratio` | `COUNT(BOUNCED='Y') / COUNT(DR_CR='D')` over CA rows in the 12m window (bounced rows are debits and count in the denominator) |
| `cmr_rank` | `commercial_report.cmr_rank` for the company PAN |
| `partner_min_score` | `MIN(partner score)` |
| `partner_avg_score` | `AVG(partner score)`, 1 decimal |
| `partner_overdue_amt` | `SUM(consumer_account.overdue)` over all accounts of all partners (any status) |
| `partner_other_bank_bal` | `SUM(fi_account.current_balance)` over AA accounts whose `owner_pan` is a partner PAN (company-owned AA accounts are excluded) |
| `dscr` | `gst_turnover_12m * 0.12 / debt_service`. For TL, `debt_service` = 12 × EMI of `amount_requested` at 11% p.a. over `tenure_requested` months, EMI = P·r / (1 − (1+r)^−n), r = 0.11/12. For WC, `debt_service` = `amount_requested * 0.11` (interest only) |

For past loans `product` and `amount` are stored, but the tenure behind their `dscr` is not. The default rate in `past_loan` is about 8%.

## 9. Exasol schemas and who may read them

The analysis writes to two Exasol schemas, with DDL in `exasol/sql/01_schemas.sql`. The semantic layer adds a third. Grants are in `exasol/sql/07_security.sql` and `exasol/semantic/11_latest_run_views.sql`. The web app and Ask Credora read as the signed-in role's Exasol user, so this table is also what each role's AI questions can reach.

| Schema / object | Holds | Admin, data scientist | Loan operations | Relationship manager |
|---|---|---|---|---|
| `CREDORA_STAGE` (`CIBIL_CONSUMER`, `CIBIL_COMMERCIAL`, `GST_FILING`, `AA_ACCOUNT`, `CA_MONTHLY`) | Raw 3rd party data fetched on demand via API, per run, each row with a purge time. `CA_MONTHLY` holds monthly current-account aggregates pushed down to Oracle | read | no | no |
| `CREDORA` (`APPLICATIONS`, `FEATURES`, `MODEL_REGISTRY`, `MEMOS`, `PURGE_LOG`) | Per-run inputs, model features, models, credit memos, purge proof | read | read | no |
| `CREDORA.CHALLENGER_SCORES` | Champion/challenger, shadow only. Per run and company it holds the challenger's `MODEL_VERSION`, `PD`, `GRADE` and the `DECISION` it would have given. `SCORE_CHALLENGER` writes it and the decision step never reads it | read | read | no |
| `CREDORA.ANOMALY` | Isolation Forest check per run and company, with `SCORE` (higher = more unusual), `IS_ANOMALY` (about 3%, CONFIG `ANOMALY_CONTAMINATION_PCT`) and `TOP_REASONS` (the figures that stand out) | read | read | no. An RM sees a flag only as the `Anomaly: ...` reason in `DECISIONS.HARD_FAILS` |
| `CREDORA` (`DECISIONS`, `SCORES`) | Decisions and offers, PD and attributions | read | read | no, only through `V_RM_DECISIONS`, `V_RM_SCORES` |
| `CREDORA` (`CONFIG`, `RUN_LOG`) | Policy knobs, run steps | read | read | read |
| `CREDORA.V_COMPANY_MASKED` | Company details with PAN and GSTIN masked | read | read | no |
| `CREDORA.RM_ASSIGNMENT` | Who works which company, with `CIF_ID`, `RM_ID`, `EXA_USER` (the manager's Exasol user, `CREDORA_RM` for the demo's `RM001`), `ASSIGNED_BY` and `ASSIGNED_AT`. It has one row per company. Loan operations' assignments write it as `CREDORA_SVC` | read | read | no, only her own rows through `V_RM_ASSIGNMENT` |
| `CREDORA.LOAN_STATUS_LOG` | Loan status history per assigned company, with `EVENT_ID`, `CIF_ID`, `RM_ID`, `STATUS` (ASSIGNED, CONTACTED, NEGOTIATING, LOAN_TAKEN, IN_PROGRESS, DISBURSED, NOT_INTERESTED), `NOTE`, `LOGGED_BY` and `LOGGED_AT`. The newest row is the current status. It is written as `CREDORA_SVC` | read | read | no, only her companies through `V_RM_LOAN_STATUS` |
| `CREDORA.RUN_PUBLISH` | Published runs, with `RUN_ID`, `PUBLISHED_BY` (`system` when an approved policy published it), `PUBLISHED_AT` and `NOTE`. It is written as `CREDORA_SVC` | read | read | read |
| `CREDORA.V_RM_DECISIONS`, `V_RM_COMPANY`, `V_RM_FEATURES`, `V_RM_SCORES`, `V_RM_ASSIGNMENT`, `V_RM_LOAN_STATUS` | Row-level security. The views return rows of the companies assigned to `CURRENT_USER`, in published runs. `V_RM_COMPANY` has full PAN and GSTIN | (return no rows) | (return no rows) | read |
| `CREDORA.V_LATEST_*` | The latest published run, one row per company. For a user with role `R_RM` they hold only the assigned companies (`V_SESSION_SCOPE`) | read | read | read (filtered) |
| `CREDORA_SEM.PORTFOLIO` | Semantic view with 16 certified metrics over the latest published run, including `anomaly_flagged_companies` | read | read | read, filtered to her assigned companies |
| `VS_CBS`, `VS_CIF`, `VS_LOS` | Virtual schemas over Oracle, MySQL, PostgreSQL | read | read | no |
| `SCHED.SCHED_TASKS`, `SCHED.SCHED_HISTORY` | The Exasol Scheduler's jobs (`TASK_ID`, `ENABLED`, `SCHEDULE` as `CRON ... TZ=Asia/Kolkata`, `SQL_TEXT`, `AFTER`, `IS_FINAL`, `COMMENT`) and every run of them (`RUN_ID`, `GRAPH_RUN_ID`, `TASK_ID`, `GRAPH_PHASE`, `SCHEDULED_FOR`, `STARTED_AT`, `FINISHED_AT` in UTC, `STATUS` SUCCEEDED / FAILED / SKIPPED / INVALID, `ERROR_MESSAGE`). DDL and jobs are in `exasol/sql/17_scheduler.sql`. The scheduler (`CREDORA_SVC`) reads the tasks and appends history. Only the deploy user writes the tasks | read | no | no |

`MODEL_REGISTRY` gets two rows per training, both measured on the same hold-out of past loans. They are `v<n>`, gradient-boosted trees (`FEATURE_IMPORTANCE` = permutation importance), and `v<n>-lr`, `ALGORITHM` 'LogisticRegression scorecard' (`FEATURE_IMPORTANCE` = signed coefficients, log-odds per standard deviation, where a positive value raises risk). Both are registered inactive, and only the very first model is activated at once. A model becomes active (`IS_ACTIVE`) only when the admin approves the data scientist's activation request (`crm.model_activation_request`). The active model is the champion and decides. The newest inactive model of the other algorithm is the challenger. `MODEL_SHA256` holds the SHA-256 of the pickled file and `PD_SCORE` refuses a file that does not match it. `MODEL_VERSION` is the primary key, so a version cannot be registered twice.

The `CREDORA` and `CREDORA_STAGE` tables are written only by `CREDORA_SVC`, which runs the analysis, training, purge, the publish step, assignments and loan status. Ask Credora logs in as the person's own AI user (`CREDORA_ADMIN_AI`, `CREDORA_DATASCI_AI`, `CREDORA_LOANOPS_AI` or `CREDORA_RM_AI`, with the same role as the person), so the AI reads exactly what that person reads. `CREDORA_MCP` stays a read-only user for results only. Exasol itself limits the relationship manager to her assigned companies. `R_RM` holds no grant on the result tables, only on the `V_RM_*` views, which join `RM_ASSIGNMENT` on the logged-in Exasol user, with an AI user `<person>_AI` matched to its person (`exasol/sql/13_rm_row_security.sql`). The backend checks the same again as defence in depth. The demo seed `exasol/sql/14_seed_rm_book.sql` gives `RM001` 25 companies (`python deploy/credora.py rm-book --env <name>`, idempotent).

**Comments in the database.** Every table and column of `CREDORA` and `CREDORA_STAGE` (17 tables, 196 columns), both schemas, the scheduler's tables and every Credora script and UDF carry the meanings in this document and in `docs/GLOSSARY.md` as Exasol comments (`exasol/sql/15_comments.sql`, applied last by the deploy tool). Read them with `SELECT COLUMN_NAME, COLUMN_COMMENT FROM EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = 'CREDORA'`. The Exasol MCP server's `describe_exasol_tables_and_views` returns them to Ask Credora. Exasol accepts comments on views only inside `CREATE VIEW`.

**Consumer groups.** `CREDORA_SVC` runs in `CREDORA_BATCH` (high priority), the role users `CREDORA_ADMIN`, `CREDORA_DATASCI`, `CREDORA_LOANOPS`, `CREDORA_RM` and `CREDORA_RM002` in `CREDORA_APP` (medium, 300 s per statement), and the AI session users `CREDORA_ADMIN_AI`, `CREDORA_DATASCI_AI`, `CREDORA_LOANOPS_AI` and `CREDORA_RM_AI` with `CREDORA_MCP` in `CREDORA_AI` (low, 60 s, 2 GiB of temporary memory per session). Only the user `CREDORA_ADMIN` holds `SELECT ANY DICTIONARY`, so the admin's AI user cannot read the audit log or the system tables. The settings are in `exasol/sql/16_resources.sql`. Every statement in `EXA_DBA_AUDIT_SQL` names its group.

**Time stamps.** `PURGE_AT`, `FETCHED_AT`, `LOGGED_AT`, `DECIDED_AT` and the other Credora time stamps are `TIMESTAMP` values in the database time zone (`DBTIMEZONE`, `EUROPE/BERLIN`, the launcher's default), compared with `SYSTIMESTAMP`. The backend converts them to UTC. `SCHED.SCHED_HISTORY` is in UTC, as the scheduler writes it.
