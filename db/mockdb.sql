-- Mock external data (PostgreSQL server "mockdb").
-- Four databases: cibil, gstn, aa (one per mock API) and truth (generator output,
-- never served by any API). Each database has a one-row "meta" table holding the
-- last generation marker, read by the mock's /status endpoint.
--
-- Runnable with psql (psql -f mockdb.sql). The generator creates the databases
-- itself, runs each \connect section and truncates the tables before loading.

SELECT 'CREATE DATABASE cibil' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cibil')\gexec
SELECT 'CREATE DATABASE gstn' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gstn')\gexec
SELECT 'CREATE DATABASE aa' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aa')\gexec
SELECT 'CREATE DATABASE truth' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'truth')\gexec

\connect cibil

CREATE TABLE IF NOT EXISTS meta (
  generated_at   TIMESTAMPTZ NOT NULL,
  seed           BIGINT,
  job_id         VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS consumer_report (
  pan            CHAR(10) PRIMARY KEY,
  name           VARCHAR(80),
  dob            DATE,
  score          INT,
  report_date    DATE,
  enquiries_6m   INT,
  enquiries_12m  INT
);

CREATE TABLE IF NOT EXISTS consumer_account (
  id             SERIAL PRIMARY KEY,
  pan            CHAR(10),
  lender         VARCHAR(40),
  acct_type      VARCHAR(30),
  opened_on      DATE,
  sanctioned     NUMERIC(18,2),
  balance        NUMERIC(18,2),
  overdue        NUMERIC(18,2),
  status         VARCHAR(12),
  dpd_36m        VARCHAR(144)
);

CREATE INDEX IF NOT EXISTS consumer_account_pan_ix ON consumer_account (pan);

CREATE TABLE IF NOT EXISTS commercial_report (
  pan            CHAR(10) PRIMARY KEY,
  name           VARCHAR(120),
  cmr_rank       INT,
  report_date    DATE,
  total_exposure NUMERIC(18,2),
  overdue        NUMERIC(18,2),
  suit_filed     BOOLEAN,
  wilful_default BOOLEAN,
  facilities     INT
);

\connect gstn

CREATE TABLE IF NOT EXISTS meta (
  generated_at   TIMESTAMPTZ NOT NULL,
  seed           BIGINT,
  job_id         VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS registration (
  gstin          CHAR(15) PRIMARY KEY,
  legal_name     VARCHAR(120),
  pan            CHAR(10),
  state          VARCHAR(30),
  registered_on  DATE,
  status         VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS filing (
  gstin          CHAR(15),
  period         CHAR(7),
  gstr1_turnover NUMERIC(18,2),
  gstr3b_tax_paid NUMERIC(18,2),
  due_date       DATE,
  filed_on       DATE,
  PRIMARY KEY (gstin, period)
);

\connect aa

CREATE TABLE IF NOT EXISTS meta (
  generated_at   TIMESTAMPTZ NOT NULL,
  seed           BIGINT,
  job_id         VARCHAR(36)
);

CREATE TABLE IF NOT EXISTS fi_account (
  aa_account_id  VARCHAR(16) PRIMARY KEY,
  owner_pan      CHAR(10),
  owner_name     VARCHAR(120),
  fip            VARCHAR(40),
  acct_type      VARCHAR(10),
  masked_no      VARCHAR(20),
  opened_on      DATE,
  current_balance NUMERIC(18,2)
);

CREATE INDEX IF NOT EXISTS fi_account_pan_ix ON fi_account (owner_pan);

CREATE TABLE IF NOT EXISTS fi_txn (
  id             BIGSERIAL PRIMARY KEY,
  aa_account_id  VARCHAR(16),
  txn_date       DATE,
  dr_cr          CHAR(1),
  amount         NUMERIC(18,2),
  narration      VARCHAR(120),
  balance_after  NUMERIC(18,2)
);

CREATE INDEX IF NOT EXISTS fi_txn_account_ix ON fi_txn (aa_account_id, txn_date);

CREATE TABLE IF NOT EXISTS consent (
  consent_id     VARCHAR(36) PRIMARY KEY,
  pan            CHAR(10),
  purpose        VARCHAR(60),
  status         VARCHAR(10),
  created_at     TIMESTAMP,
  expires_at     TIMESTAMP
);

\connect truth

CREATE TABLE IF NOT EXISTS meta (
  generated_at   TIMESTAMPTZ NOT NULL,
  seed           BIGINT,
  job_id         VARCHAR(36)
);

-- Hidden risk per company. Read only by the admin scorecard, never by a decision.
CREATE TABLE IF NOT EXISTS truth (
  cif_id         VARCHAR(8) PRIMARY KEY,
  true_pd        NUMERIC(7,5) NOT NULL,
  would_default  BOOLEAN NOT NULL
);

-- One row per finished generation job; backs the generator's GET /last.
CREATE TABLE IF NOT EXISTS generation_job (
  job_id         VARCHAR(36) PRIMARY KEY,
  seed           BIGINT,
  status         VARCHAR(10) NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  seconds        NUMERIC(10,1),
  counts         JSONB,
  error          TEXT
);
